import _ from 'lodash';
import * as viem from 'viem';
import { ChainDefinition, DeploymentInfo, InMemoryRegistry, RawChainDefinition } from '@usecannon/builder';
import { CannonRpcNode, runRpc } from '../../rpc';
import { buildFixtureRecord, ContentLoader, fixtureClients, fixtureStorage } from './__fixtures__/record';
import { computePending, createReadOnlyRuntime } from './pending';
import { PendingChange } from './types';

const CHAIN_ID = 13370;
const OWNER = viem.getAddress('0x0000000000000000000000000000000000000b0b');
const ADDRESS_A = viem.getAddress('0x00000000000000000000000000000000000a11ce');
const SOURCE = 'plan-pending-child:1.0.0';

const DEF: RawChainDefinition = {
  name: 'plan-pending',
  version: '1.0.0',
  deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
  invoke: {
    setValue: { target: ['fixture'], func: 'setValue', args: ['42'] },
    allowA: { target: ['fixture'], func: 'addToAllowlist', args: [ADDRESS_A] },
  },
};

const CLONE: RawChainDefinition = {
  name: 'plan-pending-clone',
  version: '1.0.0',
  clone: { x: { source: SOURCE, target: 'plan-pending-cloned:1.0.0' } },
};

const CLONE_DEP: RawChainDefinition = {
  name: 'plan-pending-clone-dep',
  version: '1.0.0',
  clone: { x: { source: SOURCE, target: 'plan-pending-cloned-dep:1.0.0' } },
  invoke: { touch: { target: ['x.fixture'], func: 'setLimit', args: ['9', '4'] } },
};

describe('plan pending changes', () => {
  let node: CannonRpcNode;
  let url: string;
  let main: Awaited<ReturnType<typeof buildFixtureRecord>>;
  let cloned: Awaited<ReturnType<typeof buildFixtureRecord>>;
  let clonedDep: Awaited<ReturnType<typeof buildFixtureRecord>>;
  let mainStorage: ReturnType<typeof fixtureStorage>;
  let cloneStorage: ReturnType<typeof fixtureStorage>;

  /** the read-only runtime over the storage the record was built into, as `plan()` would build it */
  const pending = (
    record: DeploymentInfo,
    storage: { registry: InMemoryRegistry; loader: ContentLoader },
    raw: RawChainDefinition
  ): Promise<PendingChange[]> => {
    const { pub } = fixtureClients(url, CHAIN_ID);
    const runtime = createReadOnlyRuntime({
      provider: pub,
      chainId: CHAIN_ID,
      registry: storage.registry,
      loaders: { ipfs: storage.loader },
    });
    return computePending(record, new ChainDefinition(raw), runtime, CHAIN_ID);
  };
  const editedDef = (edit: (d: any) => void, base: RawChainDefinition = DEF) => {
    const d = _.cloneDeep(base);
    edit(d);
    return d;
  };

  beforeAll(async () => {
    node = await runRpc({ port: 0, chainId: CHAIN_ID });
    url = node.host;
    mainStorage = fixtureStorage();
    main = await buildFixtureRecord(url, DEF, mainStorage);
    cloneStorage = fixtureStorage();
    await buildFixtureRecord(
      url,
      {
        name: 'plan-pending-child',
        version: '1.0.0',
        deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
      },
      cloneStorage
    );
    cloned = await buildFixtureRecord(url, CLONE, cloneStorage);
    clonedDep = await buildFixtureRecord(url, CLONE_DEP, cloneStorage);
  }, 120000);

  afterAll(async () => {
    if (!node) return;
    const exited = new Promise((resolve) => node.once('exit', resolve));
    node.kill('SIGTERM');
    await exited;
  });

  it('the same definition has nothing pending', async () => {
    expect(await pending(main.record, mainStorage, DEF)).toEqual([]);
  });

  it('an invoke with a changed argument is changed, and only it', async () => {
    const def = editedDef((d) => (d.invoke.setValue.args = ['43']));
    expect(await pending(main.record, mainStorage, def)).toEqual([{ step: 'invoke.setValue', change: 'changed' }]);
  });

  it('a step the record marks SKIP is never reported as changed', async () => {
    const record = _.cloneDeep(main.record);
    record.state['invoke.setValue'].hash = 'SKIP';
    const def = editedDef((d) => (d.invoke.setValue.args = ['43']));
    expect(await pending(record, mainStorage, def)).toEqual([]);
  });

  it('a new step is added', async () => {
    const def = editedDef((d) => (d.invoke.setValue2 = { target: ['fixture'], func: 'setValue', args: ['44'] }));
    expect(await pending(main.record, mainStorage, def)).toEqual([{ step: 'invoke.setValue2', change: 'added' }]);
  });

  it('a step dropped from the cannonfile is removed, listed last', async () => {
    const def = editedDef((d) => delete d.invoke.allowA);
    expect(await pending(main.record, mainStorage, def)).toEqual([{ step: 'invoke.allowA', change: 'removed' }]);
  });

  it('a removed step comes after the added and changed ones', async () => {
    const def = editedDef((d) => {
      delete d.invoke.allowA;
      d.invoke.setValue.args = ['43'];
      d.invoke.zzz = { target: ['fixture'], func: 'setValue', args: ['1'] };
    });
    expect(await pending(main.record, mainStorage, def)).toEqual([
      { step: 'invoke.setValue', change: 'changed' },
      { step: 'invoke.zzz', change: 'added' },
      { step: 'invoke.allowA', change: 'removed' },
    ]);
  });

  it('a changed deploy is changed and every invoke on it may change', async () => {
    const def = editedDef((d) => (d.deploy.fixture.args = [ADDRESS_A]));
    expect(await pending(main.record, mainStorage, def)).toEqual([
      { step: 'deploy.fixture', change: 'changed' },
      { step: 'invoke.allowA', change: 'may-change' },
      { step: 'invoke.setValue', change: 'may-change' },
    ]);
  });

  it('a changed depends alone is not a change (the raw-diff false positive)', async () => {
    const def = editedDef((d) => (d.invoke.setValue.depends = ['invoke.allowA']));
    expect(await pending(main.record, mainStorage, def)).toEqual([]);
  });

  it('a clone with the same config has nothing pending', async () => {
    expect(await pending(cloned.record, cloneStorage, CLONE)).toEqual([]);
  });

  it('a clone with a different source is changed', async () => {
    const def = editedDef((d) => (d.clone.x.source = 'plan-pending-child:2.0.0'), CLONE);
    expect(await pending(cloned.record, cloneStorage, def)).toEqual([{ step: 'clone.x', change: 'changed' }]);
  });

  it('a legacy provision step is compared like a clone', async () => {
    const record = _.cloneDeep(cloned.record);
    record.def = { name: 'plan-pending-clone', version: '1.0.0', provision: _.cloneDeep(CLONE.clone) } as any;
    record.state = { 'provision.x': record.state['clone.x'] };
    const same = { ...record.def } as RawChainDefinition;
    expect(await pending(record, cloneStorage, same)).toEqual([]);
    const moved = editedDef((d) => (d.provision.x.source = 'plan-pending-child:2.0.0'), same);
    expect(await pending(record, cloneStorage, moved)).toEqual([{ step: 'provision.x', change: 'changed' }]);
  });

  describe('a step whose state cannot be computed (its artifact is not in the record)', () => {
    // the record knows deploy.ghost, but its artifact is nowhere: the builder's getState throws for it
    const withGhost = (depends: string[]) => {
      const def = editedDef((d) => (d.deploy.ghost = { artifact: 'Ghost', args: [], depends }));
      const record = _.cloneDeep(main.record);
      record.def = def;
      record.state['deploy.ghost'] = { artifacts: {}, hash: 'recorded', version: 3 } as any;
      return { def, record };
    };

    it('is changed, never a throw', async () => {
      const { def, record } = withGhost([]);
      expect(await pending(record, mainStorage, def)).toEqual([{ step: 'deploy.ghost', change: 'changed' }]);
    });

    it('may change when a dependency is added or changed', async () => {
      const { def, record } = withGhost(['deploy.fixture']);
      def.deploy!.fixture.args = [ADDRESS_A];
      expect(await pending(record, mainStorage, def)).toEqual([
        { step: 'deploy.fixture', change: 'changed' },
        { step: 'deploy.ghost', change: 'may-change' },
        { step: 'invoke.allowA', change: 'may-change' },
        { step: 'invoke.setValue', change: 'may-change' },
      ]);
    });
  });

  // a step the record keeps with a SKIP hash is never changed by itself, so it shows only what it inherits
  const inject = (record: DeploymentInfo, def: RawChainDefinition, steps: Record<string, string>) => {
    const r = _.cloneDeep(record);
    r.def = def;
    for (const step of Object.keys(steps)) r.state[step] = { artifacts: {}, hash: 'SKIP', version: 3 } as any;
    return r;
  };

  describe('may-change reaches dependents through the whole chain, from every output kind', () => {
    it('a dependent of a dependent of a changed deploy may change', async () => {
      // invoke.b names no contract: its only link to deploy.fixture is through invoke.setValue
      const def = editedDef((d) => {
        d.deploy.fixture.args = [ADDRESS_A];
        d.invoke.b = { target: [ADDRESS_A], func: 'setValue', args: ['1'], depends: ['invoke.setValue'] };
      });
      const record = inject(main.record, def, { 'invoke.b': '' });
      expect(await pending(record, mainStorage, def)).toEqual([
        { step: 'deploy.fixture', change: 'changed' },
        { step: 'invoke.allowA', change: 'may-change' },
        { step: 'invoke.setValue', change: 'may-change' },
        { step: 'invoke.b', change: 'may-change' },
      ]);
    });

    it('a changed clone makes the invoke on it may-change', async () => {
      const def = editedDef((d) => (d.clone.x.source = 'plan-pending-child:2.0.0'), CLONE_DEP);
      expect(await pending(clonedDep.record, cloneStorage, def)).toEqual([
        { step: 'clone.x', change: 'changed' },
        { step: 'invoke.touch', change: 'may-change' },
      ]);
    });

    it('a changed router makes its dependent may-change', async () => {
      // a router is built from compiled source, which a plan never does: the recorded router has no artifact, so
      // its state cannot be computed and it is changed. Its dependent keeps a SKIP hash and shows only the inherited change.
      const def = editedDef((d) => {
        d.router = { r: { contracts: ['fixture'] } };
        d.invoke.afterRouter = { target: [ADDRESS_A], func: 'setValue', args: ['1'], depends: ['router.r'] };
      });
      const record = inject(main.record, def, { 'invoke.afterRouter': '' });
      record.state['router.r'] = { artifacts: {}, hash: 'recorded', version: 3 } as any;
      expect(await pending(record, mainStorage, def)).toEqual([
        { step: 'router.r', change: 'changed' },
        { step: 'invoke.afterRouter', change: 'may-change' },
      ]);
    });
  });

  it('a record without a misc url is still compared', async () => {
    const def: RawChainDefinition = {
      name: 'plan-pending-nomisc',
      version: '1.0.0',
      invoke: { b: { target: [ADDRESS_A], func: 'setValue', args: ['1'] } },
    };
    const record = inject(main.record, def, { 'invoke.b': '' });
    record.state = { 'invoke.b': record.state['invoke.b'] };
    delete (record as any).miscUrl;
    expect(await pending(record, mainStorage, def)).toEqual([]);
  });

  describe('createReadOnlyRuntime', () => {
    const runtime = () =>
      createReadOnlyRuntime({
        provider: fixtureClients(url, CHAIN_ID).pub,
        chainId: CHAIN_ID,
        registry: new InMemoryRegistry(),
        loaders: { ipfs: new ContentLoader() },
      });

    it('refuses to sign for any address', async () => {
      await expect(runtime().getSigner(OWNER)).rejects.toThrow('cannon plan is read-only');
    });

    it('refuses a default signer, so no step can impersonate through the node', async () => {
      await expect(runtime().getDefaultSigner({} as any)).rejects.toThrow('cannon plan is read-only');
    });
  });
});
