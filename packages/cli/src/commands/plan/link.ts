import * as viem from 'viem';
import { ChainArtifacts, ChainBuilderContext } from '@usecannon/builder';
import { RecordedEvents, shortError } from './check';
import { HintsModule, isSkipped } from './hints';
import { kindOf } from './kind';
import { bigintReplacer, sameValue } from './normalize';
import { ChainReader } from './read';
import { checkFields, checkSetter } from './setter';
import { Slot, StepResult } from './types';

type Found = { name: string; abi: viem.Abi };
type ContractsOf = {
  contracts?: Record<string, { address: viem.Address; abi: viem.Abi }>;
  imports?: Record<string, ContractsOf>;
};

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function collect(node: ContractsOf, address: viem.Address, out: Found[]): Found[] {
  for (const [name, c] of Object.entries(node.contracts || {})) {
    if (sameAddress(c.address, address)) out.push({ name, abi: c.abi });
  }
  for (const child of Object.values(node.imports || {})) collect(child, address, out);
  return out;
}

/**
 * Every contract the package recorded at the address: its own first, then its imports', recursively. One address
 * may carry several: a proxy is recorded bare and again under the ABI of the implementation it routes to.
 */
export function findContractsByAddress(ctx: ChainBuilderContext, address: viem.Address): Found[] {
  return collect(ctx as ContractsOf, address, []);
}

/** Decoded arguments in report form: bigints become decimal strings. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export async function checkOrphan(a: {
  pkg: string;
  step: string;
  artifacts: ChainArtifacts;
  ctx: ChainBuilderContext;
  reader: ChainReader;
  hints: HintsModule;
  order: number;
}): Promise<StepResult[]> {
  const kind = kindOf(a.step);
  const row = (over: Partial<StepResult>): StepResult => ({
    pkg: a.pkg,
    step: a.step,
    kind,
    status: 'orphan',
    order: a.order,
    ...over,
  });
  const unchecked = (detail?: string) =>
    row({ orphan: { effect: 'unchecked', conflicting: false }, ...(detail ? { detail } : {}) });

  if (isSkipped(a.hints, a.step)) return [row({ status: 'skipped' })];
  if (kind !== 'invoke') return [unchecked()];

  const txns = Object.values(a.artifacts.txns || {});
  if (!txns.length) return [unchecked('no recorded transactions')];

  const rows: StepResult[] = [];
  for (const txn of txns) {
    if (!txn.hash) {
      rows.push(unchecked('transaction has no recorded hash'));
      continue;
    }
    rows.push(await checkTxn(txn));
  }
  return rows;

  async function checkTxn(txn: { hash: string; events?: RecordedEvents }): Promise<StepResult> {
    const fail = (detail: string, over: Partial<StepResult> = {}) =>
      row({ orphan: { effect: 'error', conflicting: false }, detail, ...over });
    try {
      const tx = await a.reader.getTransaction(txn.hash as viem.Hex);
      // a node may return `to` in lower case; the report carries checksummed addresses
      const to = tx.to ? viem.getAddress(tx.to) : null;
      const candidates = to ? findContractsByAddress(a.ctx, to) : [];
      if (!to || !candidates.length) {
        return fail(`target ${tx.to ?? '(contract creation)'} is not a contract of this package`);
      }

      // the first contract at that address whose ABI has the called function
      const selector = tx.input.slice(0, 10).toLowerCase();
      const hasSelector = (f: viem.Abi[number]): f is viem.AbiFunction =>
        f.type === 'function' && viem.toFunctionSelector(f) === selector;
      const target = candidates.find((c) => c.abi.some(hasSelector));
      const setter = target?.abi.find(hasSelector);
      if (!target || !setter) {
        return fail(`cannot decode input ${selector} against ${candidates.map((c) => c.name).join(', ')}`);
      }
      const decoded = viem.decodeFunctionData({ abi: [setter], data: tx.input });
      const args = [...(decoded.args || [])];
      const withTarget = {
        target: { name: target.name, address: to },
        call: { func: setter.name, args: plain(args) as unknown[] },
      };

      const verdict = await checkSetter({
        step: a.step,
        setter,
        abi: target.abi,
        address: to,
        args,
        events: txn.events || {},
        reader: a.reader,
        hints: a.hints,
      });
      if (verdict.status === 'error') return fail(verdict.detail, withTarget);
      if (verdict.status === 'unchecked') {
        return row({ ...withTarget, orphan: { effect: 'unchecked', conflicting: false }, detail: verdict.detail });
      }
      return row({ ...withTarget, orphan: { effect: verdict.outcome.status, conflicting: false }, ...checkFields(verdict) });
    } catch (e) {
      return fail(shortError(e));
    }
  }
}

const slotKey = (s: Slot) => `${s.address.toLowerCase()}|${s.getter}|${s.keys}`;
const isContainsFamily = (r: StepResult) => r.check?.rule === 'auto:contains' || r.check?.rule === 'auto:notContains';
/** Rows overwrite each other by slot; in a list slot only the same member is the same write. */
const writeKey = (r: StepResult) =>
  isContainsFamily(r)
    ? `list|${slotKey(r.slot as Slot)}|${JSON.stringify(r.check?.expected, bigintReplacer)}`
    : `value|${slotKey(r.slot as Slot)}`;

const memberText = (m: unknown) => (typeof m === 'string' ? m : JSON.stringify(m, bigintReplacer));

/** Pure: returns new rows in the same order, with superseded slots, orphan links and enumeration rows added. */
export function linkResults(results: StepResult[]): StepResult[] {
  const out: StepResult[] = results.map((r) => ({ ...r, ...(r.orphan ? { orphan: { ...r.orphan } } : {}) }));
  const declared = out.filter((r) => r.status !== 'orphan' && r.slot);
  // only an invoke can change live state: var, setting, deploy, contract and router orphans never conflict
  const orphans = out.filter((r) => r.status === 'orphan' && r.kind === 'invoke' && r.slot && r.check);
  const conflict = (o: StepResult) => {
    if (o.orphan) o.orphan.conflicting = true;
  };

  // 1. several steps write one slot: the last by order judges
  const last = new Map<string, number>();
  for (const r of declared) last.set(writeKey(r), Math.max(last.get(writeKey(r)) ?? -Infinity, r.order));
  for (const r of declared) {
    if (r.status === 'drift' && r.order < (last.get(writeKey(r)) as number)) r.status = 'superseded';
  }

  // 2. an orphan wrote the value that is live on the chain
  for (const d of declared) {
    if (d.status !== 'drift' || !d.check) continue;
    const o = orphans.find(
      (x) =>
        slotKey(x.slot as Slot) === slotKey(d.slot as Slot) &&
        sameValue(
          (x.check as NonNullable<StepResult['check']>).expected,
          (d.check as NonNullable<StepResult['check']>).actual
        )
    );
    if (o) {
      d.explainedBy = o.step;
      conflict(o);
    }
  }

  // 3. members of an on-chain list that no step declared
  const groups = new Map<string, StepResult[]>();
  for (const r of declared) {
    if (r.check?.rule !== 'auto:contains') continue;
    const k = slotKey(r.slot as Slot);
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  let next = results.reduce((m, r) => Math.max(m, r.order), -1) + 1;
  for (const rows of groups.values()) {
    const first = rows[0];
    const members = rows.map((r) => (r.check as NonNullable<StepResult['check']>).expected);
    const chain = Array.isArray(first.check?.actual) ? (first.check?.actual as unknown[]) : [];
    const extras = chain.filter((m) => !members.some((d) => sameValue(d, m)));
    const row: StepResult = {
      pkg: first.pkg,
      step: '(enumeration)',
      kind: 'enumeration',
      status: extras.length ? 'drift' : 'in-sync',
      order: next++,
      ...(first.target ? { target: first.target } : {}),
      slot: first.slot,
      check: {
        rule: 'enum:contains',
        getter: (first.check as NonNullable<StepResult['check']>).getter,
        expected: members,
        actual: chain,
      },
    };
    if (extras.length) {
      row.detail = `undeclared member(s): ${extras.map(memberText).join(', ')}`;
      const explainers = orphans.filter(
        (o) =>
          o.check?.rule === 'auto:contains' &&
          slotKey(o.slot as Slot) === slotKey(first.slot as Slot) &&
          extras.some((x) => sameValue(x, o.check?.expected))
      );
      if (explainers.length) {
        row.explainedBy = [...new Set(explainers.map((o) => o.step))].join(', ');
        explainers.forEach(conflict);
      }
    }
    out.push(row);
  }
  return out;
}
