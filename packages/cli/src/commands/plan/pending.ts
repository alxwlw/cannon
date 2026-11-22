import _ from 'lodash';
import * as viem from 'viem';
import {
  addOutputsToContext,
  CannonLoader,
  CannonRegistry,
  ChainArtifacts,
  ChainBuilderContext,
  ChainBuilderRuntime,
  ChainDefinition,
  createInitialContext,
  DeploymentInfo,
} from '@usecannon/builder';
import { shortError } from './check';
import { kindOf } from './kind';
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

// a change in one of these can alter the addresses and outputs steps downstream read
const OUTPUT_KINDS = new Set(['deploy', 'router', 'clone']);

/**
 * What the next build of `gitDef` would add, change or remove against the recorded deployment. It compares the
 * builder's own step hashes with the recorded ones, the way `build()` decides to re-run a step, not the raw config
 * text: a `depends` edit is not a change. Nothing is compiled, so a changed contract source is not detected.
 * A step that cannot be rendered is `changed` (`may-change` below an added or changed dependency). A step whose state
 * cannot be computed is judged by its config: configured otherwise than recorded is `changed`, the same config below
 * such a dependency is `may-change`; with the same config and nothing upstream the failure is its own (a registry
 * lookup that failed) and computePending rejects.
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

  /** Whether the cannonfile configures `n` as the record did: both rendered in `ctx`, `depends` left out. */
  const sameConfig = (n: string, config: unknown, ctx: ChainBuilderContext) => {
    let recorded: unknown;
    try {
      recorded = recordDef.getConfig(n, ctx);
    } catch {
      // the cannonfile's config renders in this context and the record's does not (or it has none): not the same
      return false;
    }
    return _.isEqual(_.omit(config as object, 'depends'), _.omit(recorded as object, 'depends'));
  };

  type Change = 'changed' | 'may-change' | null;
  /** The change of a step present in both, or null when a build would leave it as recorded. */
  const judge = async (n: string, ctx: ChainBuilderContext, hash: string | null | undefined): Promise<Change> => {
    const changedIf = (yes: boolean): Change => (yes ? 'changed' : null);
    let config: unknown;
    try {
      config = gitDef.getConfig(n, ctx);
      // clone always re-runs, so its hash says nothing: compare what it is configured with
      if (kindOf(n) === 'clone') return changedIf(JSON.stringify(config) !== JSON.stringify(recordDef.getConfig(n, ctx)));
    } catch {
      // cannot be rendered against the record: a build would not run it as it is either
      return upstream(n) ? 'may-change' : 'changed';
    }
    let cur: string[] | null;
    try {
      cur = await gitDef.getState(n, runtime, ctx, false);
    } catch (err) {
      // the state needs what the record lacks (the artifact of an upgrade, a module not deployed yet): the config tells
      if (!sameConfig(n, config, ctx)) return 'changed';
      // the same config below an added or changed dependency, whose outputs the record does not have
      if (upstream(n)) return 'may-change';
      // the same config and nothing upstream: a failure of its own (a registry lookup, say), not a change; the run fails
      throw new Error(`cannot compute the state of ${n}: ${shortError(err)}`);
    }
    return changedIf(hash !== 'SKIP' && !!cur && !cur.includes(hash || ''));
  };

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

    const change = await judge(n, ctx, recorded.hash);
    if (change) listed.set(n, change);

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
