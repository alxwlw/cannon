import _ from 'lodash';
import * as viem from 'viem';
import { DeploymentInfo, RawChainDefinition } from '@usecannon/builder';
import { CannonRpcNode, runRpc } from '../../rpc';
import { buildFixtureRecord, fixtureStorage } from './__fixtures__/record';
import { createChainReader } from './read';
import { StepResult } from './types';
import { walkRecord, WalkOptions } from './walk';

const CHAIN_ID = 13370;
const OWNER = viem.getAddress('0x0000000000000000000000000000000000000b0b');
const NOT_EXECUTED = 'declared, not in record (never executed)';
const PULLED = 'pulled package — not checked';
const BEYOND_DEPTH = 'nested package beyond --depth';
const SOURCE = 'plan-walk-child:1.0.0';

type Built = Awaited<ReturnType<typeof buildFixtureRecord>>;
const pkg = (name: string, rest: Partial<RawChainDefinition>): RawChainDefinition =>
  ({ name, version: '1.0.0', ...rest } as RawChainDefinition);
const shape = (rows: StepResult[]) => rows.map((r) => [r.pkg, r.step, r.kind, r.status, r.order]);
/** What a clone/pull step recorded for its import: the nested record URL and the imported contracts. */
const importOf = (record: DeploymentInfo, step: string, name: string) =>
  record.state[step].artifacts.imports?.[name] as { url: string; contracts: Record<string, { address: viem.Address }> };

describe('walkRecord: nested packages', () => {
  let node: CannonRpcNode;
  let url: string;
  let child: Built;
  let parent: Built;
  let provisioned: Built;
  let grand: Built;
  let pulled: Built;
  let legacyImport: Built;
  let childUrl: string;

  const walkAt = async (built: Built, over: Partial<WalkOptions> = {}, record = built.record) =>
    walkRecord(record, 'root', {
      chainId: CHAIN_ID,
      reader: await createChainReader(url),
      readBlob: built.readBlob,
      hints: {},
      depth: Infinity,
      bytecode: true,
      ...over,
    });
  /** parent's readBlob, but the cloned child's record comes from `answer`. */
  const childAs = (answer: () => Promise<unknown>) => (u: string) => u === childUrl ? answer() : parent.readBlob(u);

  beforeAll(async () => {
    node = await runRpc({ port: 0, chainId: CHAIN_ID });
    url = node.host;
    const storage = fixtureStorage();
    child = await buildFixtureRecord(
      url,
      pkg('plan-walk-child', {
        deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
        invoke: { setValue: { target: ['fixture'], func: 'setValue', args: ['46'] } },
      }),
      storage
    );
    // the invoke on the imported contract depends on the import, so it sorts after it
    parent = await buildFixtureRecord(
      url,
      pkg('plan-walk-parent', {
        clone: { child: { source: SOURCE, target: 'plan-walk-cloned:1.0.0' } },
        invoke: { touchChild: { target: ['child.fixture'], func: 'setLimit', args: ['9', '4'] } },
      }),
      storage
    );
    provisioned = await buildFixtureRecord(
      url,
      pkg('plan-walk-provision', { provision: { c: { source: SOURCE, target: 'plan-walk-provisioned:1.0.0' } } }),
      storage
    );
    grand = await buildFixtureRecord(
      url,
      pkg('plan-walk-grand', {
        clone: { parent: { source: 'plan-walk-parent:1.0.0', target: 'plan-walk-grand-parent:1.0.0' } },
      }),
      storage
    );
    pulled = await buildFixtureRecord(
      url,
      pkg('plan-walk-pull', {
        pull: { child: { source: SOURCE } },
        invoke: { touchChild: { target: ['child.fixture'], func: 'setLimit', args: ['11', '3'] } },
      }),
      storage
    );
    legacyImport = await buildFixtureRecord(
      url,
      pkg('plan-walk-import', { import: { child: { source: SOURCE } } }),
      storage
    );
    childUrl = importOf(parent.record, 'clone.child', 'child').url;
  }, 120000);

  afterAll(async () => {
    if (!node) return;
    const exited = new Promise((resolve) => node.once('exit', resolve));
    node.kill('SIGTERM');
    await exited;
  });

  it('walks into a cloned package after the parent rows, under <parent>.<import name>', async () => {
    const rows = await walkAt(parent);
    expect(shape(rows)).toEqual([
      ['root', 'invoke.touchChild', 'invoke', 'in-sync', 0],
      ['root.child', 'deploy.fixture', 'deploy', 'in-sync', 1],
      ['root.child', 'invoke.setValue', 'invoke', 'in-sync', 2],
    ]);
    // a clone is a deployment of its own: every row is about the cloned contract, not the source package's
    const cloned = importOf(parent.record, 'clone.child', 'child').contracts.fixture.address;
    expect(cloned).not.toBe(child.addresses.fixture);
    expect(rows.map((r) => r.target?.address)).toEqual(Array(3).fill(cloned));
    expect(rows[2].check?.actual).toEqual(['46']);
  });

  it('legacy provision.* is a clone: walked the same way, its own row reported as kind clone', async () => {
    expect(shape(await walkAt(provisioned))).toEqual([
      ['root.c', 'deploy.fixture', 'deploy', 'in-sync', 0],
      ['root.c', 'invoke.setValue', 'invoke', 'in-sync', 1],
    ]);
    const neverRan = _.cloneDeep(provisioned.record);
    delete neverRan.state['provision.c'];
    expect(await walkAt(provisioned, {}, neverRan)).toEqual([
      { pkg: 'root', step: 'provision.c', kind: 'clone', status: 'unchecked', order: 0, detail: NOT_EXECUTED },
    ]);
  });

  it('a pulled package is someone else deployment: one unchecked row, no walk, its contracts still serve own invokes', async () => {
    const rows = await walkAt(pulled);
    expect(shape(rows)).toEqual([
      ['root', 'pull.child', 'pull', 'unchecked', 0],
      ['root', 'invoke.touchChild', 'invoke', 'in-sync', 1],
    ]);
    expect(rows[0].detail).toBe(PULLED);
    expect(rows[1].target?.address).toBe(child.addresses.fixture);
    // a pulled package has no bytecode rows of this package either way
    expect(shape(await walkAt(pulled, { bytecode: false }))).toEqual(shape(rows));
  });

  it('legacy import.* is a pull: one unchecked row, no walk, reported as kind pull', async () => {
    expect(await walkAt(legacyImport)).toEqual([
      { pkg: 'root', step: 'import.child', kind: 'pull', status: 'unchecked', order: 0, detail: PULLED },
    ]);
    const neverRan = _.cloneDeep(legacyImport.record);
    delete neverRan.state['import.child'];
    expect(await walkAt(legacyImport, {}, neverRan)).toEqual([
      { pkg: 'root', step: 'import.child', kind: 'pull', status: 'unchecked', order: 0, detail: NOT_EXECUTED },
    ]);
  });

  it('depth bounds the walk: each level takes one, a clone past it is one unchecked row', async () => {
    expect(await walkAt(grand, { depth: 0 })).toEqual([
      { pkg: 'root', step: 'clone.parent', kind: 'clone', status: 'unchecked', order: 0, detail: BEYOND_DEPTH },
    ]);
    const one = await walkAt(grand, { depth: 1 });
    expect(shape(one)).toEqual([
      ['root.parent', 'clone.child', 'clone', 'unchecked', 0],
      ['root.parent', 'invoke.touchChild', 'invoke', 'in-sync', 1],
    ]);
    expect(one[0].detail).toBe(BEYOND_DEPTH);
    expect((await walkAt(grand, { depth: 2 })).map((r) => r.pkg)).toEqual([
      'root.parent',
      'root.parent.child',
      'root.parent.child',
    ]);
  });

  it('a nested record reached twice is walked once, under the first import', async () => {
    const twice = _.cloneDeep(parent.record);
    const clones = twice.def.clone as Record<string, unknown>;
    clones.d = _.cloneDeep(clones.child);
    // a second clone step whose recorded import points at the very record the first one made
    const first = twice.state['clone.child'];
    const imports = _.cloneDeep(first.artifacts.imports ?? {});
    twice.state['clone.d'] = { ...first, artifacts: { imports: { d: imports.child } } };
    expect(importOf(twice, 'clone.d', 'd').url).toBe(childUrl);
    expect(shape(await walkAt(parent, {}, twice))).toEqual([
      ['root', 'invoke.touchChild', 'invoke', 'in-sync', 0],
      ['root.child', 'deploy.fixture', 'deploy', 'in-sync', 1],
      ['root.child', 'invoke.setValue', 'invoke', 'in-sync', 2],
    ]);
  });

  it('a nested record that cannot be read, or is missing, is one package error row', async () => {
    const row = (detail: string) => ({
      pkg: 'root.child',
      step: '(package)',
      kind: 'package',
      status: 'error',
      order: 1,
      detail,
    });
    const failed = await walkAt(parent, { readBlob: childAs(() => Promise.reject(new Error('store down'))) });
    expect(failed.slice(1)).toEqual([row(`read ${childUrl}: store down`)]);
    const missing = await walkAt(parent, { readBlob: childAs(async () => null) });
    expect(missing.slice(1)).toEqual([row(`read ${childUrl}: not found`)]);
  });

  it('a nested record of another chain is not checked against this one', async () => {
    const cloned = await parent.readBlob(childUrl);
    const rows = await walkAt(parent, { readBlob: childAs(async () => ({ ...cloned, chainId: 1 })) });
    expect(rows.slice(1)).toEqual([
      {
        pkg: 'root.child',
        step: '(package)',
        kind: 'package',
        status: 'unchecked',
        order: 1,
        detail: `deployed on chain 1, not on ${CHAIN_ID}`,
      },
    ]);
    const unknownChain = await walkAt(parent, { readBlob: childAs(async () => ({ ...cloned, chainId: null })) });
    expect(unknownChain.map((r) => [r.pkg, r.status])).toEqual([
      ['root', 'in-sync'],
      ['root.child', 'in-sync'],
      ['root.child', 'in-sync'],
    ]);
  });
});
