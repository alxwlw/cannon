import fs from 'node:fs/promises';
import path from 'node:path';
import * as viem from 'viem';
import { CannonLoader, CannonRegistry, CannonStorage, DeploymentInfo } from '@usecannon/builder';
import { getMainLoader } from '../../loader';
import { createDefaultReadRegistry } from '../../registry';
import { resolveCliSettings } from '../../settings';
import { getPackageInfo, loadCannonfile } from '../../helpers';
import { loadHints, makeRead } from './hints';
import { linkResults } from './link';
import { computePending, createReadOnlyRuntime } from './pending';
import { createChainReader } from './read';
import { buildReport, exitCodeOf, toJson, toMarkdown } from './report';
import { PendingChange, PlanReport, StepResult } from './types';
import { walkRecord } from './walk';

export interface PlanOptions {
  packageRef: string;
  chainId?: number;
  rpcUrl: string;
  cannonfile?: string;
  hints?: string;
  block?: bigint;
  depth?: number;
  bytecode: boolean;
  out?: string;
  json: boolean;
}

export interface LoadedRecord {
  fullPackageRef: string;
  chainId: number;
  record: DeploymentInfo;
  readBlob: (url: string) => Promise<any>;
}

export interface PlanDeps {
  loadRecord?: (o: PlanOptions) => Promise<LoadedRecord>;
  /**
   * Where nested blobs are read from: the default record loader's `readBlob` and the pending runtime use it. The
   * top-level lookup (ipfs refs, chain id resolution) always goes through `getPackageInfo`, with its own registry.
   */
  storage?: { registry: CannonRegistry; loaders: { [scheme: string]: CannonLoader } };
}

/**
 * Checks a deployed package record against the live chain and, with a cannonfile, lists what a build would change.
 * Read-only: it creates public clients only, never a signer, and every check reads one block fixed at the start.
 */
export async function plan(o: PlanOptions, deps: PlanDeps = {}): Promise<{ report: PlanReport; exitCode: 0 | 2 }> {
  const loaded = await (deps.loadRecord ?? ((opts: PlanOptions) => defaultLoadRecord(opts, deps.storage)))(o);

  const rpcChainId = await viem.createPublicClient({ transport: viem.http(o.rpcUrl) }).getChainId();
  if (rpcChainId !== loaded.chainId) {
    throw new Error(
      `the RPC at the given URL is chain ${rpcChainId}, but the package is deployed on chain ${loaded.chainId}`
    );
  }

  const reader = await createChainReader(o.rpcUrl, { block: o.block });
  const hints = await loadHints(o.hints);

  const walked = await walkRecord(loaded.record, loaded.fullPackageRef, {
    chainId: loaded.chainId,
    reader,
    readBlob: loaded.readBlob,
    hints,
    depth: o.depth ?? Infinity,
    bytecode: o.bytecode,
  });

  // enumerations see the walked rows and may add more; `order` is the index in the combined array
  const read = makeRead(reader);
  const rows: StepResult[] = [...walked];
  for (const enumerate of hints.enumerations ?? []) {
    rows.push(...(await enumerate({ results: walked, read })));
  }
  const steps = linkResults(rows.map((r, order) => ({ ...r, order })));

  let pending: PendingChange[] = [];
  if (o.cannonfile) {
    const { def } = await loadCannonfile(o.cannonfile);
    const storage = deps.storage ?? (await defaultStorage());
    const runtime = createReadOnlyRuntime({
      provider: viem.createPublicClient({ transport: viem.http(o.rpcUrl) }),
      chainId: loaded.chainId,
      registry: storage.registry,
      loaders: storage.loaders,
    });
    pending = await computePending(loaded.record, def, runtime, loaded.chainId);
  }

  const report = buildReport({
    pkg: loaded.fullPackageRef,
    chainId: loaded.chainId,
    block: reader.blockNumber,
    steps,
    pending,
  });

  if (o.out) {
    await fs.mkdir(o.out, { recursive: true });
    await fs.writeFile(path.join(o.out, 'plan.json'), toJson(report));
    await fs.writeFile(path.join(o.out, 'plan.md'), toMarkdown(report));
  }
  process.stdout.write(o.json ? toJson(report) : toMarkdown(report));

  return { report, exitCode: exitCodeOf(report) };
}

async function defaultStorage() {
  const cliSettings = resolveCliSettings();
  return { registry: await createDefaultReadRegistry(cliSettings), loaders: getMainLoader(cliSettings) };
}

async function defaultLoadRecord(o: PlanOptions, given: PlanDeps['storage']): Promise<LoadedRecord> {
  const { fullPackageRef, chainId, deployInfo } = await getPackageInfo(o.packageRef, o.chainId, o.rpcUrl);
  const storage = given ?? (await defaultStorage());
  const blobs = new CannonStorage(storage.registry, storage.loaders);
  return { fullPackageRef, chainId, record: deployInfo, readBlob: (url) => blobs.readBlob(url) };
}
