import _ from 'lodash';
import * as viem from 'viem';
import {
  addOutputsToContext,
  ChainArtifacts,
  ChainBuilderContext,
  ChainDefinition,
  ContractData,
  createInitialContext,
  DeploymentInfo,
  getContractDefinitionFromPath,
  getContractFromPath,
} from '@usecannon/builder';
import { ByteRange, compareCode } from './bytecode';
import { RecordedEvents, shortError } from './check';
import { HintsModule, isSkipped } from './hints';
import { kindOf } from './kind';
import { checkOrphan } from './link';
import { ChainReader } from './read';
import { checkFields, checkSetter, decodeArgs } from './setter';
import { StepResult } from './types';

export interface WalkOptions {
  chainId: number;
  reader: ChainReader;
  readBlob: (url: string) => Promise<any>;
  hints: HintsModule;
  /** How many levels of nested packages (`clone` imports) to walk into. */
  depth: number;
  /** false: no deployed bytecode rows, and the package's misc blob is never read. */
  bytecode: boolean;
}

type Row = Omit<StepResult, 'order'>;
type Artifact = { deployedBytecode?: string; immutableReferences?: unknown };
/** The rendered fields this walker reads; `getConfig` returns the action's own config type. */
type StepConfig = { chains?: number[]; target?: string | string[]; func?: string; args?: unknown[]; abi?: string };

const NOT_EXECUTED = 'declared, not in record (never executed)';
const PACKAGE_STEP = '(package)';

const byteLength = (hex: string | undefined) => (hex ? hex.replace(/^0x/i, '').length / 2 : null);

/** Forge `immutableReferences` (`{ [astId]: [{ start, length }] }`) flattened; undefined when the artifact has none. */
function immutableRangesOf(artifact: Artifact | undefined): ByteRange[] | undefined {
  const refs = artifact?.immutableReferences;
  if (!refs || typeof refs !== 'object') return undefined;
  return Object.values(refs as Record<string, ByteRange[]>).flat();
}

/** Matches the way the builder picks the function: full signature (`f(uint256)`) or bare name, first match. */
function findSetter(abi: viem.Abi, func: string): viem.AbiFunction | undefined {
  const want = func.replace(/\s/g, '');
  return abi.find(
    (f): f is viem.AbiFunction =>
      f.type === 'function' &&
      (f.name === func ||
        viem.toFunctionSignature(f) === want ||
        `${f.name}(${f.inputs.map((i) => i.type).join(',')})` === want)
  );
}

/**
 * Checks every step of a deployment record against the chain the reader is pinned to, and walks into the packages
 * it cloned. A pulled package is someone else's deployment: it is neither walked nor checked.
 * Never throws because of one step: a step that cannot be rendered or checked is an `error` row.
 * `order` is the index in the returned array; rows of nested packages follow their parent's.
 */
export async function walkRecord(record: DeploymentInfo, pkgPath: string, opts: WalkOptions): Promise<StepResult[]> {
  const rows: Row[] = [];
  await walkPackage(record, pkgPath, opts.depth, opts, rows, new Set());
  return rows.map((r, order) => ({ ...r, order }));
}

async function walkPackage(
  record: DeploymentInfo,
  pkg: string,
  depth: number,
  opts: WalkOptions,
  rows: Row[],
  seen: Set<string>
): Promise<void> {
  let def: ChainDefinition;
  let steps: string[];
  try {
    def = new ChainDefinition(record.def);
    steps = def.topologicalActions;
  } catch (e) {
    rows.push({ pkg, step: PACKAGE_STEP, kind: 'package', status: 'error', detail: `definition: ${shortError(e)}` });
    return;
  }

  const state = record.state ?? {};
  const initialCtx = await createInitialContext(def, record.meta ?? {}, opts.chainId, record.options ?? {});
  const built = new Map<string, ChainArtifacts>();
  const nested: { name: string; url: string }[] = [];
  let misc: Promise<Record<string, Artifact>> | undefined;
  const loadMisc = () => (misc ??= readMisc(record, opts));

  for (const n of steps) {
    // the context of one step, exactly as `build()` makes it: the step's dependencies (transitively, through
    // `built`) plus its own recorded artifacts, on a fresh copy of the initial context
    const ctx = _.cloneDeep(initialCtx);
    const artifacts: ChainArtifacts = {};
    for (const dep of def.getDependencies(n)) _.merge(artifacts, built.get(dep));
    addOutputsToContext(ctx, artifacts);
    const recorded = state[n];
    const own: ChainArtifacts = recorded?.artifacts ?? {};
    if (recorded) addOutputsToContext(ctx, own);
    built.set(n, _.merge(artifacts, own));

    const kind = kindOf(n);
    const base = { pkg, step: n, kind };
    const notExecuted = (): Row => ({ ...base, status: 'unchecked', detail: NOT_EXECUTED });
    if (isSkipped(opts.hints, n)) {
      rows.push({ ...base, status: 'skipped' });
      continue;
    }

    let cfg: StepConfig;
    try {
      cfg = def.getConfig(n, ctx);
    } catch (e) {
      rows.push(recorded ? { ...base, status: 'error', detail: `render: ${shortError(e)}` } : notExecuted());
      continue;
    }
    // `build()` skips such a step without recording it, so its absence is not news
    if (cfg.chains && !cfg.chains.includes(opts.chainId)) continue;
    if (!recorded) {
      rows.push(notExecuted());
      continue;
    }

    if (kind === 'invoke') {
      rows.push(...(await checkInvoke(n, cfg, ctx, own.txns ?? {})));
    } else if (kind === 'clone') {
      if (depth > 0) {
        for (const [name, imp] of Object.entries(own.imports ?? {})) if (imp?.url) nested.push({ name, url: imp.url });
      }
    } else if (kind !== 'pull' && opts.bytecode) {
      // not `pull`: a pulled package is someone else's deployment, its drift is not this package's (no rows, no walk)
      for (const [name, c] of Object.entries(own.contracts ?? {})) rows.push(await checkCode(n, name, c));
    }
  }

  const declared = new Set(steps);
  const orphans = Object.keys(state).filter((n) => !declared.has(n));
  if (orphans.length) {
    // an orphan has no dependency list: its target may be any contract the package recorded, nested ones included
    const all = _.cloneDeep(initialCtx);
    for (const s of Object.values(state)) addOutputsToContext(all, s.artifacts ?? {});
    for (const n of orphans) {
      const found = await checkOrphan({
        pkg,
        step: n,
        artifacts: state[n].artifacts ?? {},
        ctx: all,
        reader: opts.reader,
        hints: opts.hints,
        order: rows.length,
      });
      rows.push(...found);
    }
  }

  for (const { name, url } of nested) {
    if (seen.has(url)) continue;
    seen.add(url);
    const sub = `${pkg}.${name}`;
    const fail = (detail: string) => rows.push({ pkg: sub, step: PACKAGE_STEP, kind: 'package', status: 'error', detail });
    let child: DeploymentInfo | null;
    try {
      child = await opts.readBlob(url);
    } catch (e) {
      fail(`read ${url}: ${shortError(e)}`);
      continue;
    }
    if (!child) {
      fail(`read ${url}: not found`);
      continue;
    }
    // `clone` builds on this chain, so only a foreign or edited record lands here: its addresses mean nothing on this one
    if (typeof child.chainId === 'number' && child.chainId !== opts.chainId) {
      rows.push({
        pkg: sub,
        step: PACKAGE_STEP,
        kind: 'package',
        status: 'unchecked',
        detail: `deployed on chain ${child.chainId}, not on ${opts.chainId}`,
      });
      continue;
    }
    await walkPackage(child, sub, depth - 1, opts, rows, seen);
  }

  async function checkInvoke(
    n: string,
    cfg: StepConfig,
    ctx: ChainBuilderContext,
    txns: NonNullable<ChainArtifacts['txns']>
  ): Promise<Row[]> {
    const base = { pkg, step: n, kind: 'invoke' };
    const targets = typeof cfg.target === 'string' ? [cfg.target] : cfg.target ?? [];
    let customAbi: viem.Abi | null;
    try {
      customAbi = resolveAbi(cfg.abi, ctx);
    } catch (e) {
      return [{ ...base, status: 'error', detail: `abi: ${shortError(e)}` }];
    }
    const label = n.split('.')[1];
    const out: Row[] = [];
    for (const t of targets) {
      // `build()` names the transaction of each target this way
      const events: RecordedEvents = txns[targets.length === 1 ? label : `${label}_${t}`]?.events ?? {};
      try {
        out.push(await checkTarget(n, t, cfg, customAbi, ctx, events));
      } catch (e) {
        out.push({ ...base, status: 'error', detail: `target ${t}: ${shortError(e)}` });
      }
    }
    return out;
  }

  async function checkTarget(
    n: string,
    t: string,
    cfg: StepConfig,
    customAbi: viem.Abi | null,
    ctx: ChainBuilderContext,
    events: RecordedEvents
  ): Promise<Row> {
    const base = { pkg, step: n, kind: 'invoke' };
    let contract: { address: viem.Address; abi: viem.Abi };
    if (viem.isAddress(t)) {
      if (!customAbi) return { ...base, status: 'error', detail: `target ${t}: an address target needs abi` };
      contract = { address: t, abi: customAbi };
    } else {
      const found = getContractFromPath(ctx, t);
      if (!found) return { ...base, status: 'error', detail: `target ${t} not found` };
      contract = { address: found.address, abi: customAbi ?? found.abi };
    }

    const args = cfg.args ?? [];
    const target = { name: t, address: contract.address };
    const setter = findSetter(contract.abi, cfg.func ?? '');
    if (!setter) {
      return {
        ...base,
        target,
        call: { func: cfg.func ?? '', args },
        status: 'error',
        detail: `setter ${cfg.func} not in ABI`,
      };
    }
    const withCall = { ...base, target, call: { func: setter.name, args } };
    let decoded: readonly unknown[];
    try {
      decoded = decodeArgs(setter, args);
    } catch (e) {
      return { ...withCall, status: 'error', detail: `args: ${shortError(e)}` };
    }
    const verdict = await checkSetter({
      step: n,
      setter,
      abi: contract.abi,
      address: contract.address,
      args: decoded,
      events,
      reader: opts.reader,
      hints: opts.hints,
    });
    if (verdict.status !== 'checked') return { ...withCall, status: verdict.status, detail: verdict.detail };
    return { ...withCall, status: verdict.outcome.status, ...checkFields(verdict) };
  }

  async function checkCode(n: string, name: string, c: ContractData): Promise<Row> {
    const base = { pkg, step: n, kind: 'deploy', target: { name, address: c.address } };
    try {
      const artifacts = await loadMisc();
      const art = artifacts[`${c.sourceName}:${c.contractName}`] ?? artifacts[c.contractName] ?? artifacts[name];
      const code = await opts.reader.getCode(c.address);
      const r = compareCode(code, art?.deployedBytecode, immutableRangesOf(art));
      return {
        ...base,
        status: r.status,
        check: { rule: 'code', getter: 'getCode', expected: byteLength(art?.deployedBytecode), actual: byteLength(code) },
        ...(r.detail ? { detail: r.detail } : {}),
      };
    } catch (e) {
      return { ...base, status: 'error', detail: shortError(e) };
    }
  }
}

/** The ABI of `cfg.abi` as the builder resolves it: a JSON array, else the ABI of a contract at that path. */
function resolveAbi(abi: string | undefined, ctx: ChainBuilderContext): viem.Abi | null {
  if (typeof abi !== 'string') return null;
  if (abi.trimStart().startsWith('[')) return JSON.parse(abi);
  return getContractDefinitionFromPath(ctx, abi)?.abi ?? null;
}

async function readMisc(record: DeploymentInfo, opts: WalkOptions): Promise<Record<string, Artifact>> {
  if (!record.miscUrl) return {};
  let blob: { artifacts?: Record<string, Artifact> } | null;
  try {
    blob = await opts.readBlob(record.miscUrl);
  } catch (e) {
    throw new Error(`misc ${record.miscUrl}: ${shortError(e)}`);
  }
  if (!blob) throw new Error(`misc ${record.miscUrl}: not found`);
  return blob.artifacts ?? {};
}
