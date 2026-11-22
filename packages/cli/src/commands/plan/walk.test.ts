import _ from 'lodash';
import * as viem from 'viem';
import { DeploymentInfo, RawChainDefinition } from '@usecannon/builder';
import { CannonRpcNode, runRpc } from '../../rpc';
import fixture from './__fixtures__/PlanFixture.json';
import { buildFixtureRecord, fixtureClients, fixtureStorage } from './__fixtures__/record';
import { HintContext, HintsModule } from './hints';
import { ChainReader, createChainReader } from './read';
import { StepResult } from './types';
import { walkRecord, WalkOptions } from './walk';

const CHAIN_ID = 13370;
const OWNER = viem.getAddress('0x0000000000000000000000000000000000000b0b');
const ADDRESS_A = viem.getAddress('0x00000000000000000000000000000000000a11ce');
const THING = viem.padHex('0x2a', { size: 32 });
const NORMALIZED = 'normalized by contract (matches recorded event)';
const NOT_EXECUTED = 'declared, not in record (never executed)';
const abi = fixture.abi as viem.Abi;
const VALUE_ABI = abi.filter((f) => f.type === 'function' && (f.name === 'setValue' || f.name === 'getValue'));

const DEF: RawChainDefinition = {
  name: 'plan-walk',
  version: '1.0.0',
  deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
  invoke: {
    setValue: { target: ['fixture'], func: 'setValue', args: ['42'] },
    setLimit: { target: ['fixture'], func: 'setLimit', args: ['7', '5'] },
    allowA: { target: ['fixture'], func: 'addToAllowlist', args: [ADDRESS_A] },
    setDelay: { target: ['fixture'], func: 'setDelay', args: ['0'] },
    init: { target: ['fixture'], func: 'initializeThing', args: [THING] },
  },
};

const VARIANTS: RawChainDefinition = {
  name: 'plan-walk-variants',
  version: '1.0.0',
  deploy: {
    fixture: { artifact: 'PlanFixture', args: [OWNER] },
    fixture2: { artifact: 'PlanFixture', args: [ADDRESS_A] },
  },
  invoke: {
    setDelay: { target: ['fixture', 'fixture2'], func: 'setDelay', args: ['0'] },
    byJsonAbi: {
      target: ['<%= contracts.fixture2.address %>'],
      abi: JSON.stringify(VALUE_ABI),
      func: 'setValue',
      args: ['43'],
    },
    byPathAbi: {
      target: ['<%= contracts.fixture2.address %>'],
      abi: 'fixture2',
      func: 'setLimit(uint128,uint256)',
      args: ['8', '6'],
    },
    otherChain: { target: ['fixture'], func: 'setValue', args: ['44'], chains: [1] },
  },
};

const LEGACY: RawChainDefinition = {
  name: 'plan-walk-legacy',
  version: '1.0.0',
  contract: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
  invoke: { setValue: { target: ['fixture'], func: 'setValue', args: ['45'] } },
};

const brief = (r: StepResult) => ({
  step: r.step,
  kind: r.kind,
  status: r.status,
  rule: r.check?.rule,
  detail: r.detail,
});
const byStep = (rows: StepResult[], step: string) => rows.filter((r) => r.step === step);

function failingCall(reader: ChainReader, getter: string): ChainReader {
  return {
    blockNumber: reader.blockNumber,
    call: (address, fn, args) =>
      fn.name === getter ? Promise.reject(new Error(`${getter} unavailable`)) : reader.call(address, fn, args),
    getCode: (address) => reader.getCode(address),
    getTransaction: (hash) => reader.getTransaction(hash),
  };
}

describe('walkRecord', () => {
  let node: CannonRpcNode;
  let url: string;
  let main: Awaited<ReturnType<typeof buildFixtureRecord>>;
  let baseBlock: bigint;

  const opts = async (over: Partial<WalkOptions> = {}): Promise<WalkOptions> => ({
    chainId: CHAIN_ID,
    reader: await createChainReader(url, { block: baseBlock }),
    readBlob: main.readBlob,
    hints: {},
    depth: Infinity,
    bytecode: true,
    ...over,
  });
  const edited = (edit: (r: DeploymentInfo) => void) => {
    const r = _.cloneDeep(main.record);
    edit(r);
    return r;
  };

  beforeAll(async () => {
    node = await runRpc({ port: 0, chainId: CHAIN_ID });
    url = node.host;
    main = await buildFixtureRecord(url, DEF);
    baseBlock = await viem.createPublicClient({ transport: viem.http(url) }).getBlockNumber();
  }, 60000);

  afterAll(async () => {
    if (!node) return;
    const exited = new Promise((resolve) => node.once('exit', resolve));
    node.kill('SIGTERM');
    await exited;
  });

  it('untouched chain: every declared check in sync, init unchecked, bytecode in sync', async () => {
    const rows = await walkRecord(main.record, 'root', await opts());
    expect(rows.map(brief)).toEqual([
      { step: 'deploy.fixture', kind: 'deploy', status: 'in-sync', rule: 'code', detail: undefined },
      { step: 'invoke.allowA', kind: 'invoke', status: 'in-sync', rule: 'auto:contains', detail: undefined },
      { step: 'invoke.init', kind: 'invoke', status: 'unchecked', rule: undefined, detail: 'no derivable getter' },
      { step: 'invoke.setDelay', kind: 'invoke', status: 'in-sync', rule: 'auto:equal/1', detail: NORMALIZED },
      { step: 'invoke.setLimit', kind: 'invoke', status: 'in-sync', rule: 'auto:equal/1', detail: undefined },
      { step: 'invoke.setValue', kind: 'invoke', status: 'in-sync', rule: 'auto:equal/1', detail: undefined },
    ]);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.pkg)).toEqual(Array(6).fill('root'));
    for (const r of rows) expect(r.target).toEqual({ name: 'fixture', address: main.addresses.fixture });
    expect(byStep(rows, 'invoke.setLimit')[0]).toMatchObject({
      call: { func: 'setLimit', args: ['7', '5'] },
      check: { getter: 'getLimit', expected: ['5'], actual: ['5'] },
      slot: { address: main.addresses.fixture, getter: 'getLimit', keys: '["7"]' },
    });
    expect(byStep(rows, 'deploy.fixture')[0].check).toEqual({
      rule: 'code',
      getter: 'getCode',
      expected: (fixture.deployedBytecode.length - 2) / 2,
      actual: (fixture.deployedBytecode.length - 2) / 2,
    });
  });

  it('a value changed on chain after the build is drift with the declared and live values', async () => {
    const { chain, pub, wallet } = fixtureClients(url, CHAIN_ID);
    const hash = await wallet.writeContract({
      address: main.addresses.fixture,
      abi,
      functionName: 'setValue',
      args: [99n],
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });

    const rows = await walkRecord(main.record, 'root', await opts({ reader: await createChainReader(url) }));
    expect(byStep(rows, 'invoke.setValue')[0]).toMatchObject({
      status: 'drift',
      check: { rule: 'auto:equal/1', getter: 'getValue', expected: ['42'], actual: ['99'] },
      slot: { address: main.addresses.fixture, getter: 'getValue', keys: '[]' },
    });
    expect(rows.filter((r) => r.status === 'drift').map((r) => r.step)).toEqual(['invoke.setValue']);
  });

  it('a failing read errors only its own step, the rest of the walk is unchanged', async () => {
    const base = await opts();
    const good = await walkRecord(main.record, 'root', base);
    const rows = await walkRecord(main.record, 'root', { ...base, reader: failingCall(base.reader, 'getLimit') });
    expect(byStep(rows, 'invoke.setLimit')[0]).toMatchObject({
      status: 'error',
      check: { rule: 'auto:equal/1', getter: 'getLimit', expected: null, actual: null },
      detail: 'getLimit unavailable',
    });
    const others = (rs: StepResult[]) => rs.filter((r) => r.step !== 'invoke.setLimit');
    expect(others(rows)).toEqual(others(good));
    expect(rows).toHaveLength(good.length);
  });

  it('hints: skip wins first, a hint outcome overrides the auto rule, null falls back, a throw is an error', async () => {
    const seen: HintContext[] = [];
    const hints: HintsModule = {
      skip: ['invoke.init'],
      checks: {
        setValue: async (ctx) => {
          seen.push(ctx);
          return { status: 'drift', getter: 'hinted', expected: 'from-hint', actual: 'chain-says' };
        },
        setLimit: async () => null,
        addToAllowlist: async () => {
          throw new Error('hint exploded');
        },
      },
    };
    const rows = await walkRecord(main.record, 'root', await opts({ hints }));
    expect(rows.map(brief)).toEqual([
      { step: 'deploy.fixture', kind: 'deploy', status: 'in-sync', rule: 'code', detail: undefined },
      {
        step: 'invoke.allowA',
        kind: 'invoke',
        status: 'error',
        rule: undefined,
        detail: 'hint addToAllowlist: hint exploded',
      },
      { step: 'invoke.init', kind: 'invoke', status: 'skipped', rule: undefined, detail: undefined },
      { step: 'invoke.setDelay', kind: 'invoke', status: 'in-sync', rule: 'auto:equal/1', detail: NORMALIZED },
      { step: 'invoke.setLimit', kind: 'invoke', status: 'in-sync', rule: 'auto:equal/1', detail: undefined },
      { step: 'invoke.setValue', kind: 'invoke', status: 'drift', rule: 'hint:setValue', detail: undefined },
    ]);
    expect(byStep(rows, 'invoke.setValue')[0].check).toEqual({
      rule: 'hint:setValue',
      getter: 'hinted',
      expected: 'from-hint',
      actual: 'chain-says',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ step: 'invoke.setValue', args: ['42'], address: main.addresses.fixture, events: {} });
    expect(seen[0].setter.name).toBe('setValue');
    expect(seen[0].abi).toEqual(abi);
    expect(await seen[0].read(main.addresses.fixture, 'getValue() view returns (uint256)', [])).toBe(42n);
  });

  it('a step dropped from the definition but kept in the record is an orphan, checked against all recorded contracts', async () => {
    const record = edited((r) => delete (r.def.invoke as Record<string, unknown>).setDelay);
    const rows = await walkRecord(record, 'root', await opts());
    const orphans = byStep(rows, 'invoke.setDelay');
    expect(orphans).toHaveLength(1);
    // checkOrphan takes the address from the transaction, which the node returns in lower case
    const { target, slot, ...rest } = orphans[0];
    expect([target?.name, viem.getAddress(target?.address ?? '0x')]).toEqual(['fixture', main.addresses.fixture]);
    expect([viem.getAddress(slot?.address ?? '0x'), slot?.getter, slot?.keys]).toEqual([
      main.addresses.fixture,
      'getDelay',
      '[]',
    ]);
    expect(rest).toEqual({
      pkg: 'root',
      step: 'invoke.setDelay',
      kind: 'invoke',
      status: 'orphan',
      order: 5,
      call: { func: 'setDelay', args: ['0'] },
      orphan: { effect: 'in-sync', conflicting: false },
      check: { rule: 'auto:equal/1', getter: 'getDelay', expected: ['0'], actual: ['1'] },
      detail: NORMALIZED,
    });
    expect(rows).toHaveLength(6);
  });

  it('a declared step absent from the record is unchecked as never executed', async () => {
    const record = edited((r) => delete r.state['invoke.setValue']);
    const rows = await walkRecord(record, 'root', await opts());
    expect(byStep(rows, 'invoke.setValue')).toEqual([
      { pkg: 'root', step: 'invoke.setValue', kind: 'invoke', status: 'unchecked', order: 5, detail: NOT_EXECUTED },
    ]);
  });

  it('a recorded step without artifacts is walked as one that produced nothing', async () => {
    const record = edited((r) => delete (r.state['deploy.fixture'] as { artifacts?: unknown }).artifacts);
    const rows = await walkRecord(record, 'root', await opts());
    expect(rows.map((r) => [r.step, r.status, r.detail])).toEqual([
      ['invoke.allowA', 'error', 'target fixture not found'],
      ['invoke.init', 'error', 'target fixture not found'],
      ['invoke.setDelay', 'error', 'target fixture not found'],
      ['invoke.setLimit', 'error', 'target fixture not found'],
      ['invoke.setValue', 'error', 'target fixture not found'],
    ]);
  });

  it('a definition the builder cannot load is one package error row', async () => {
    const record = edited((r) => ((r.def as Record<string, unknown>).bogus = { x: {} }));
    const rows = await walkRecord(record, 'root', await opts());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pkg: 'root', step: '(package)', kind: 'package', status: 'error', order: 0 });
    expect(rows[0].detail).toMatch(/^definition: Unrecognized action type bogus/);
  });

  describe('a broken step is that step error row, the walk goes on', () => {
    const setValue = (r: DeploymentInfo) => (r.def.invoke as Record<string, Record<string, unknown>>).setValue;
    const walkEdited = async (edit: (cfg: Record<string, unknown>) => void) => {
      const rows = await walkRecord(
        edited((r) => edit(setValue(r))),
        'root',
        await opts()
      );
      expect(rows.filter((r) => r.step !== 'invoke.setValue').map((r) => r.status)).toEqual([
        'in-sync',
        'in-sync',
        'unchecked',
        'in-sync',
        'in-sync',
      ]);
      return byStep(rows, 'invoke.setValue');
    };

    it('render failure', async () => {
      const rows = await walkEdited((cfg) => (cfg.args = ['<%= settings.missing.deep %>']));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'error', kind: 'invoke' });
      expect(rows[0].detail).toMatch(/^render: Cannot read properties of undefined \(reading 'deep'\)/);
    });

    // without a contract path the step depends on nothing, so it sorts right after deploy.fixture
    it('unknown target', async () => {
      const rows = await walkEdited((cfg) => (cfg.target = ['nowhere']));
      expect(rows).toEqual([
        {
          pkg: 'root',
          step: 'invoke.setValue',
          kind: 'invoke',
          status: 'error',
          order: 1,
          detail: 'target nowhere not found',
        },
      ]);
    });

    it('address target without abi', async () => {
      const rows = await walkEdited((cfg) => (cfg.target = [main.addresses.fixture]));
      expect(rows).toEqual([
        {
          pkg: 'root',
          step: 'invoke.setValue',
          kind: 'invoke',
          status: 'error',
          order: 1,
          detail: `target ${main.addresses.fixture}: an address target needs abi`,
        },
      ]);
    });

    it('setter missing from the ABI', async () => {
      const rows = await walkEdited((cfg) => (cfg.func = 'setValueTwice'));
      expect(rows).toEqual([
        {
          pkg: 'root',
          step: 'invoke.setValue',
          kind: 'invoke',
          status: 'error',
          order: 5,
          target: { name: 'fixture', address: main.addresses.fixture },
          call: { func: 'setValueTwice', args: ['42'] },
          detail: 'setter setValueTwice not in ABI',
        },
      ]);
    });

    it('custom abi that is not JSON', async () => {
      const rows = await walkEdited((cfg) => (cfg.abi = '[not json'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'error', order: 5 });
      expect(rows[0].target).toBeUndefined();
      expect(rows[0].detail).toMatch(/^abi: .*JSON/);
    });

    it('custom abi whose function item is malformed', async () => {
      const rows = await walkEdited((cfg) => (cfg.abi = JSON.stringify([{ type: 'function', name: 'setValue' }])));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'error', order: 5 });
      expect(rows[0].target).toBeUndefined();
      expect(rows[0].detail).toMatch(/^target fixture: /);
    });
  });

  describe('built variants', () => {
    let variants: Awaited<ReturnType<typeof buildFixtureRecord>>;
    let legacy: Awaited<ReturnType<typeof buildFixtureRecord>>;
    const walkOn = async (record: DeploymentInfo) =>
      walkRecord(record, 'root', await opts({ reader: await createChainReader(url) }));

    beforeAll(async () => {
      variants = await buildFixtureRecord(url, VARIANTS);
      legacy = await buildFixtureRecord(url, LEGACY);
    }, 60000);

    it('one row per target, each checked with its own recorded events', async () => {
      const rows = byStep(await walkOn(variants.record), 'invoke.setDelay');
      expect(rows.map((r) => [r.target, r.status, r.check?.actual, r.detail])).toEqual([
        [{ name: 'fixture', address: variants.addresses.fixture }, 'in-sync', ['1'], NORMALIZED],
        [{ name: 'fixture2', address: variants.addresses.fixture2 }, 'in-sync', ['1'], NORMALIZED],
      ]);
      expect(variants.addresses.fixture).not.toBe(variants.addresses.fixture2);
    });

    it('an address target takes its ABI from a JSON abi or a contract path; func may be a full signature', async () => {
      const rows = await walkOn(variants.record);
      const target = { name: variants.addresses.fixture2, address: variants.addresses.fixture2 };
      expect(byStep(rows, 'invoke.byJsonAbi')).toMatchObject([
        { status: 'in-sync', target, call: { func: 'setValue', args: ['43'] }, check: { actual: ['43'] } },
      ]);
      expect(byStep(rows, 'invoke.byPathAbi')).toMatchObject([
        { status: 'in-sync', target, call: { func: 'setLimit', args: ['8', '6'] }, check: { actual: ['6'] } },
      ]);
    });

    it('a step whose chains exclude this chain is neither checked nor reported as missing', async () => {
      expect(variants.record.state['invoke.otherChain']).toBeUndefined();
      const rows = await walkOn(variants.record);
      expect(byStep(rows, 'invoke.otherChain')).toEqual([]);
      expect(rows.map((r) => r.step)).toEqual([
        'deploy.fixture',
        'deploy.fixture2',
        'invoke.byJsonAbi',
        'invoke.byPathAbi',
        'invoke.setDelay',
        'invoke.setDelay',
      ]);
    });

    it('legacy contract.* is reported as kind deploy, also as an orphan; its dangling invoke cannot find the target', async () => {
      const rows = await walkOn(legacy.record);
      expect(rows.map(brief)).toEqual([
        { step: 'contract.fixture', kind: 'deploy', status: 'in-sync', rule: 'code', detail: undefined },
        { step: 'invoke.setValue', kind: 'invoke', status: 'in-sync', rule: 'auto:equal/1', detail: undefined },
      ]);
      const dropped = _.cloneDeep(legacy.record);
      delete (dropped.def as Record<string, unknown>).contract;
      expect((await walkOn(dropped)).map(brief)).toEqual([
        { step: 'invoke.setValue', kind: 'invoke', status: 'error', rule: undefined, detail: 'target fixture not found' },
        { step: 'contract.fixture', kind: 'deploy', status: 'orphan', rule: undefined, detail: undefined },
      ]);
    });

    it('reads the misc blob of a package once, however many contracts it checks', async () => {
      const reads: string[] = [];
      const readBlob = (u: string) => {
        reads.push(u);
        return variants.readBlob(u);
      };
      const rows = await walkRecord(variants.record, 'root', await opts({ readBlob, reader: await createChainReader(url) }));
      expect(rows.filter((r) => r.kind === 'deploy').map((r) => r.status)).toEqual(['in-sync', 'in-sync']);
      expect(reads).toEqual([variants.record.miscUrl]);
    });
  });

  describe('deployed bytecode', () => {
    const SIZE = (fixture.deployedBytecode.length - 2) / 2;
    const broken = { ...fixture, deployedBytecode: '0x00' };
    /** readBlob of the main record whose misc blob holds `artifacts` (an Error rejects, null is "not found"). */
    const withMisc = (artifacts: Record<string, unknown> | null | Error) => {
      const reads: string[] = [];
      const readBlob = async (u: string) => {
        reads.push(u);
        if (u !== main.record.miscUrl) return main.readBlob(u);
        if (artifacts instanceof Error) throw artifacts;
        return artifacts && { artifacts };
      };
      return { readBlob, reads };
    };
    const codeRows = async (over: Partial<WalkOptions>, record = main.record) =>
      byStep(await walkRecord(record, 'root', await opts(over)), 'deploy.fixture');
    // every byte of the window flipped, so each window is exactly one 32-byte differing range
    const flip = (hex: string, starts: number[]) => {
      const bytes = viem.hexToBytes(hex as viem.Hex);
      for (const s of starts) for (let i = s; i < s + 32; i++) bytes[i] ^= 0xff;
      return viem.bytesToHex(bytes);
    };

    it('looks the artifact up by sourceName:contractName, then contractName, then the step contract name', async () => {
      const statusWith = async (artifacts: Record<string, unknown>) =>
        (await codeRows({ readBlob: withMisc(artifacts).readBlob }))[0].status;
      expect(await statusWith({ 'PlanFixture.sol:PlanFixture': fixture, PlanFixture: broken, fixture: broken })).toBe(
        'in-sync'
      );
      expect(await statusWith({ PlanFixture: fixture, fixture: broken })).toBe('in-sync');
      expect(await statusWith({ fixture })).toBe('in-sync');
      expect(await codeRows({ readBlob: withMisc({}).readBlob })).toEqual([
        {
          pkg: 'root',
          step: 'deploy.fixture',
          kind: 'deploy',
          status: 'unchecked',
          order: 0,
          target: { name: 'fixture', address: main.addresses.fixture },
          check: { rule: 'code', getter: 'getCode', expected: null, actual: SIZE },
          detail: 'no artifact',
        },
      ]);
    });

    it('masks exactly the immutable ranges the artifact declares; without them the size heuristic applies', async () => {
      const deployedBytecode = flip(fixture.deployedBytecode, [100, 300]);
      const rowWith = async (extra: Record<string, unknown>) =>
        (await codeRows({ readBlob: withMisc({ PlanFixture: { ...fixture, deployedBytecode, ...extra } }).readBlob }))[0];

      const both = { '7': [{ start: 100, length: 32 }], '9': [{ start: 300, length: 32 }] };
      const masked = await rowWith({ immutableReferences: both });
      expect([masked.status, masked.detail]).toEqual(['in-sync', undefined]);
      expect(await rowWith({ immutableReferences: { '7': [{ start: 100, length: 32 }] } })).toMatchObject({
        status: 'drift',
        detail: '1 differing range(s) outside immutables, first at byte 300',
      });
      expect(await rowWith({ immutableReferences: {} })).toMatchObject({
        status: 'drift',
        detail: '2 differing range(s) outside immutables, first at byte 100',
      });
      expect(await rowWith({})).toMatchObject({ status: 'in-sync', detail: 'equal modulo 2 immutable slot(s)' });
    });

    it('a misc blob that cannot be read errors the bytecode rows and nothing else', async () => {
      const target = { name: 'fixture', address: main.addresses.fixture };
      const rows = await walkRecord(
        main.record,
        'root',
        await opts({ readBlob: withMisc(new Error('store down')).readBlob })
      );
      expect(byStep(rows, 'deploy.fixture')).toEqual([
        {
          pkg: 'root',
          step: 'deploy.fixture',
          kind: 'deploy',
          status: 'error',
          order: 0,
          target,
          detail: `misc ${main.record.miscUrl}: store down`,
        },
      ]);
      expect(rows.filter((r) => r.kind === 'invoke').map((r) => r.status)).toEqual([
        'in-sync',
        'unchecked',
        'in-sync',
        'in-sync',
        'in-sync',
      ]);
      expect(await codeRows({ readBlob: withMisc(null).readBlob })).toMatchObject([
        { status: 'error', detail: `misc ${main.record.miscUrl}: not found` },
      ]);
    });

    it('a record without misc has no artifact to compare and reads no blob', async () => {
      const spy = withMisc({ PlanFixture: fixture });
      const rows = await codeRows(
        { readBlob: spy.readBlob },
        edited((r) => (r.miscUrl = ''))
      );
      expect(rows).toMatchObject([{ status: 'unchecked', detail: 'no artifact' }]);
      expect(spy.reads).toEqual([]);
    });

    it('bytecode off: no bytecode rows, and the misc blob is never read', async () => {
      const spy = withMisc({ PlanFixture: fixture });
      const rows = await walkRecord(main.record, 'root', await opts({ readBlob: spy.readBlob, bytecode: false }));
      expect(rows.map((r) => r.step)).toEqual([
        'invoke.allowA',
        'invoke.init',
        'invoke.setDelay',
        'invoke.setLimit',
        'invoke.setValue',
      ]);
      expect(spy.reads).toEqual([]);
    });

    it('a failing code read errors that contract only', async () => {
      const base = await opts();
      const reader: ChainReader = { ...base.reader, getCode: () => Promise.reject(new Error('code unavailable')) };
      const rows = await walkRecord(main.record, 'root', { ...base, reader });
      expect(rows.map((r) => [r.step, r.status, r.detail])).toEqual([
        ['deploy.fixture', 'error', 'code unavailable'],
        ['invoke.allowA', 'in-sync', undefined],
        ['invoke.init', 'unchecked', 'no derivable getter'],
        ['invoke.setDelay', 'in-sync', NORMALIZED],
        ['invoke.setLimit', 'in-sync', undefined],
        ['invoke.setValue', 'in-sync', undefined],
      ]);
    });
  });

  describe('nested packages', () => {
    const source = 'plan-walk-child:1.0.0';
    let child: Awaited<ReturnType<typeof buildFixtureRecord>>;
    let parent: Awaited<ReturnType<typeof buildFixtureRecord>>;
    let grand: Awaited<ReturnType<typeof buildFixtureRecord>>;
    let twice: Awaited<ReturnType<typeof buildFixtureRecord>>;
    let legacyImport: Awaited<ReturnType<typeof buildFixtureRecord>>;
    let childUrl: string;
    const walkAt = async (built: typeof parent, over: Partial<WalkOptions> = {}) =>
      walkRecord(
        built.record,
        'root',
        await opts({ readBlob: built.readBlob, reader: await createChainReader(url), ...over })
      );
    const shape = (rows: StepResult[]) => rows.map((r) => [r.pkg, r.step, r.kind, r.status, r.order]);
    /** parent's readBlob, but the child record comes from `answer`. */
    const childAs = (answer: () => Promise<unknown>) => (u: string) => u === childUrl ? answer() : parent.readBlob(u);

    beforeAll(async () => {
      const storage = fixtureStorage();
      child = await buildFixtureRecord(
        url,
        {
          name: 'plan-walk-child',
          version: '1.0.0',
          deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
          invoke: { setValue: { target: ['fixture'], func: 'setValue', args: ['46'] } },
        },
        storage
      );
      // the invoke on the pulled contract depends on the pull, so it sorts after it
      const pkg = (name: string, rest: Partial<RawChainDefinition>): RawChainDefinition =>
        ({ name, version: '1.0.0', ...rest } as RawChainDefinition);
      parent = await buildFixtureRecord(
        url,
        pkg('plan-walk-parent', {
          pull: { child: { source } },
          invoke: { touchChild: { target: ['child.fixture'], func: 'setLimit', args: ['9', '4'] } },
        }),
        storage
      );
      grand = await buildFixtureRecord(
        url,
        pkg('plan-walk-grand', { pull: { parent: { source: 'plan-walk-parent:1.0.0' } } }),
        storage
      );
      twice = await buildFixtureRecord(url, pkg('plan-walk-twice', { pull: { a: { source }, b: { source } } }), storage);
      legacyImport = await buildFixtureRecord(url, pkg('plan-walk-import', { import: { child: { source } } }), storage);
      childUrl = parent.record.state['pull.child'].artifacts.imports?.child.url as string;
    }, 60000);

    it('walks into a pulled package after the parent rows, under <parent>.<import name>', async () => {
      const rows = await walkAt(parent);
      expect(shape(rows)).toEqual([
        ['root', 'invoke.touchChild', 'invoke', 'in-sync', 0],
        ['root.child', 'deploy.fixture', 'deploy', 'in-sync', 1],
        ['root.child', 'invoke.setValue', 'invoke', 'in-sync', 2],
      ]);
      expect(rows.map((r) => r.target?.address)).toEqual(Array(3).fill(child.addresses.fixture));
      expect(rows[2].check?.actual).toEqual(['46']);
    });

    it('depth bounds the walk: each level takes one', async () => {
      expect(shape(await walkAt(grand, { depth: 0 }))).toEqual([]);
      expect(shape(await walkAt(grand, { depth: 1 }))).toEqual([
        ['root.parent', 'invoke.touchChild', 'invoke', 'in-sync', 0],
      ]);
      expect((await walkAt(grand, { depth: 2 })).map((r) => r.pkg)).toEqual([
        'root.parent',
        'root.parent.child',
        'root.parent.child',
      ]);
    });

    it('a package imported twice is walked once, under the first import', async () => {
      expect(shape(await walkAt(twice))).toEqual([
        ['root.a', 'deploy.fixture', 'deploy', 'in-sync', 0],
        ['root.a', 'invoke.setValue', 'invoke', 'in-sync', 1],
      ]);
    });

    it('legacy import.* recurses like pull', async () => {
      expect((await walkAt(legacyImport)).map((r) => r.pkg)).toEqual(['root.child', 'root.child']);
    });

    it('a nested record that cannot be read, or is missing, is one package error row', async () => {
      const failed = await walkAt(parent, { readBlob: childAs(() => Promise.reject(new Error('store down'))) });
      expect(failed.slice(1)).toEqual([
        {
          pkg: 'root.child',
          step: '(package)',
          kind: 'package',
          status: 'error',
          order: 1,
          detail: `read ${childUrl}: store down`,
        },
      ]);
      const missing = await walkAt(parent, { readBlob: childAs(async () => null) });
      expect(missing.slice(1)).toEqual([
        {
          pkg: 'root.child',
          step: '(package)',
          kind: 'package',
          status: 'error',
          order: 1,
          detail: `read ${childUrl}: not found`,
        },
      ]);
    });

    it('a nested record of another chain is not checked against this one', async () => {
      const rows = await walkAt(parent, { readBlob: childAs(async () => ({ ...child.record, chainId: 1 })) });
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
      const unknownChain = await walkAt(parent, { readBlob: childAs(async () => ({ ...child.record, chainId: null })) });
      expect(unknownChain.map((r) => [r.pkg, r.status])).toEqual([
        ['root', 'in-sync'],
        ['root.child', 'in-sync'],
        ['root.child', 'in-sync'],
      ]);
    });
  });
});
