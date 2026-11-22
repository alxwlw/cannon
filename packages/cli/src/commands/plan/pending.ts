import _ from 'lodash';
import * as viem from 'viem';
import {
  addOutputsToContext,
  CannonLoader,
  CannonRegistry,
  ChainArtifacts,
  ChainBuilderRuntime,
  ChainDefinition,
  createInitialContext,
  DeploymentInfo,
} from '@usecannon/builder';
import { PendingChange } from './types';

const READ_ONLY = 'cannon plan is read-only';

/**
 * A builder runtime that cannot sign. Both signer paths reject, and `getDefaultSigner` is always given: without
 * it the runtime would fall back to impersonating through the node's test client. No wallet client, no account.
 * It has no `getArtifact` either: nothing is compiled, artifacts come from the record's misc.
 */
export function createReadOnlyRuntime(a: {
  provider: viem.PublicClient;
  chainId: number;
  registry: CannonRegistry;
  loaders: { [scheme: string]: CannonLoader };
}): ChainBuilderRuntime {
  const refuse = () => Promise.reject(new Error(READ_ONLY));
  return new ChainBuilderRuntime(
    {
      provider: a.provider,
      chainId: a.chainId,
      snapshots: false,
      allowPartialDeploy: false,
      getSigner: refuse,
      getDefaultSigner: refuse,
    },
    a.registry,
    a.loaders,
    Object.keys(a.loaders)[0]
  );
}

// legacy kinds count as their new names
const KIND_ALIASES: Record<string, string> = { contract: 'deploy', provision: 'clone', import: 'pull' };
const kindOf = (step: string) => {
  const kind = step.split('.')[0];
  return KIND_ALIASES[kind] ?? kind;
};
// a change in one of these can alter the addresses and outputs steps downstream read
const OUTPUT_KINDS = new Set(['deploy', 'router', 'clone']);

/**
 * What the next build of `gitDef` would add, change or remove against the recorded deployment. It compares the
 * builder's own step hashes with the recorded ones, the way `build()` decides to re-run a step, not the raw config
 * text: a `depends` edit is not a change. Nothing is compiled, so a changed contract source is not detected.
 */
export async function computePending(
  record: DeploymentInfo,
  gitDef: ChainDefinition,
  runtime: ChainBuilderRuntime,
  chainId: number
): Promise<PendingChange[]> {
  if (record.miscUrl) await runtime.restoreMisc(record.miscUrl);
  const recordDef = new ChainDefinition(record.def);
  const initial = await createInitialContext(gitDef, record.meta ?? {}, chainId, record.options ?? {});

  const listed = new Map<string, PendingChange['change']>();
  const built = new Map<string, ChainArtifacts>();

  const transitiveDeps = (n: string, seen = new Set<string>()): Set<string> => {
    for (const dep of gitDef.getDependencies(n)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        transitiveDeps(dep, seen);
      }
    }
    return seen;
  };
  const upstream = (n: string, only?: (dep: string) => boolean) =>
    [...transitiveDeps(n)].some((dep) => {
      const change = listed.get(dep);
      return (change === 'added' || change === 'changed') && (!only || only(dep));
    });

  for (const n of gitDef.topologicalActions) {
    const recorded = record.state[n];
    if (!recorded) {
      listed.set(n, 'added');
      continue;
    }

    // the context the builder gives this step: the initial one, the artifacts of its dependencies, its own
    const ctx = _.cloneDeep(initial);
    const artifacts: ChainArtifacts = {};
    for (const dep of gitDef.getDependencies(n)) _.merge(artifacts, built.get(dep));
    addOutputsToContext(ctx, artifacts);
    addOutputsToContext(ctx, recorded.artifacts);

    try {
      let changed: boolean;
      if (kindOf(n) === 'clone') {
        // clone always re-runs, so its hash says nothing: compare what it is configured with
        changed = JSON.stringify(gitDef.getConfig(n, ctx)) !== JSON.stringify(recordDef.getConfig(n, ctx));
      } else {
        const cur = await gitDef.getState(n, runtime, ctx, false);
        changed = recorded.hash !== 'SKIP' && !!cur && !cur.includes(recorded.hash || '');
      }
      if (changed) listed.set(n, 'changed');
    } catch (err) {
      // cannot be evaluated against this chain: a build would not run it as-is either
      listed.set(n, upstream(n) ? 'may-change' : 'changed');
    }

    built.set(n, _.merge(artifacts, recorded.artifacts));
  }

  // not changed itself, but built on an output that is
  for (const n of gitDef.topologicalActions) {
    if (!listed.has(n) && record.state[n] && upstream(n, (dep) => OUTPUT_KINDS.has(kindOf(dep)))) {
      listed.set(n, 'may-change');
    }
  }

  const pending: PendingChange[] = gitDef.topologicalActions
    .filter((n) => listed.has(n))
    .map((step) => ({ step, change: listed.get(step)! }));

  const kept = new Set(gitDef.allActionNames);
  for (const step of recordDef.topologicalActions) {
    if (record.state[step] && !kept.has(step)) pending.push({ step, change: 'removed' });
  }
  return pending;
}
