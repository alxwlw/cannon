import { Console } from 'node:console';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as viem from 'viem';
import * as viemAccounts from 'viem/accounts';
import { DeploymentInfo, RawChainDefinition } from '@usecannon/builder';
import { CannonRpcNode, runRpc } from '../../rpc';
import commandsConfig from '../config';
import fixture from './__fixtures__/PlanFixture.json';
import { buildFixtureRecord, fixtureClients, fixtureStorage } from './__fixtures__/record';
import { LoadedRecord, plan, PlanOptions } from './index';

const CHAIN_ID = 13370;
const OWNER = viem.getAddress('0x0000000000000000000000000000000000000b0b');
const abi = fixture.abi as viem.Abi;

const def = (name: string, extra: Partial<RawChainDefinition> = {}): RawChainDefinition => ({
  name,
  version: '1.0.0',
  deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
  invoke: { setValue: { target: ['fixture'], func: 'setValue', args: ['42'] } },
  ...extra,
});

describe('plan() orchestration', () => {
  let node: CannonRpcNode;
  let url: string;
  let tmp: string;
  let stdout: jest.SpyInstance;

  const options = (over: Partial<PlanOptions> = {}): PlanOptions => ({
    packageRef: 'unused:1.0.0',
    rpcUrl: url,
    bytecode: true,
    json: false,
    ...over,
  });
  /** a loader that serves a record built into fixture storage, as the default loader would serve a published one */
  const loaded = (b: Awaited<ReturnType<typeof buildFixtureRecord>>, over: Partial<LoadedRecord> = {}) => {
    const l: LoadedRecord = {
      fullPackageRef: 'plan-test:1.0.0@main',
      chainId: CHAIN_ID,
      record: b.record,
      readBlob: b.readBlob,
      ...over,
    };
    return async () => l;
  };
  const printed = () => stdout.mock.calls.map((c) => String(c[0])).join('');

  beforeAll(async () => {
    node = await runRpc({ port: 0, chainId: CHAIN_ID });
    url = node.host;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cannon-plan-'));
  }, 60000);

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    if (!node) return;
    const exited = new Promise((resolve) => node.once('exit', resolve));
    node.kill('SIGTERM');
    await exited;
  });

  it('an untouched record: exit 0, markdown on stdout, no pending without a cannonfile', async () => {
    const b = await buildFixtureRecord(url, def('plan-untouched'));
    const { report, exitCode } = await plan(options(), { loadRecord: loaded(b) });

    expect(exitCode).toBe(0);
    expect(report.pending).toEqual([]);
    expect(report.steps.map((s) => [s.step, s.status])).toEqual([
      ['deploy.fixture', 'in-sync'],
      ['invoke.setValue', 'in-sync'],
    ]);
    expect(report.chainId).toBe(CHAIN_ID);
    expect(printed()).toMatch(/^# cannon plan — plan-test:1\.0\.0@main\n/);
    expect(() => JSON.parse(printed())).toThrow();
  });

  it('--json prints the JSON report instead of markdown', async () => {
    const b = await buildFixtureRecord(url, def('plan-json'));
    const { report } = await plan(options({ json: true }), { loadRecord: loaded(b) });

    const parsed = JSON.parse(printed());
    expect(parsed).toMatchObject({ version: 1, package: 'plan-test:1.0.0@main', chainId: CHAIN_ID });
    expect(parsed.block).toBe(report.block);
    expect(printed()).not.toContain('# cannon plan');
  });

  it('--json: what prints to stdout during the run goes to stderr, so stdout is the report alone', async () => {
    const b = await buildFixtureRecord(url, def('plan-json-noisy'));
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // a Node console on process.stdout, the way the registry prints its offline warning (`log` in util/console.ts)
    const noisy = new Console({ stdout: process.stdout, stderr: process.stderr });
    const write = process.stdout.write;
    const load = loaded(b);
    await plan(options({ json: true }), {
      loadRecord: async () => {
        noisy.log('warning: offline, local registry only');
        return load();
      },
    });

    expect(JSON.parse(printed())).toMatchObject({ version: 1, package: 'plan-test:1.0.0@main' });
    expect(stderr.mock.calls.map((c) => String(c[0]))).toEqual(['warning: offline, local registry only\n']);
    expect(process.stdout.write).toBe(write);
  });

  it('--json: stdout is put back when the run fails', async () => {
    const b = await buildFixtureRecord(url, def('plan-json-fails'));
    const write = process.stdout.write;
    await expect(plan(options({ json: true }), { loadRecord: loaded(b, { chainId: 1 }) })).rejects.toThrow('chain 1');
    expect(process.stdout.write).toBe(write);
    process.stdout.write('after the run\n');
    expect(printed()).toBe('after the run\n');
  });

  it('a markdown run leaves stdout alone', async () => {
    const b = await buildFixtureRecord(url, def('plan-md-noisy'));
    const noisy = new Console({ stdout: process.stdout, stderr: process.stderr });
    const load = loaded(b);
    await plan(options(), {
      loadRecord: async () => {
        noisy.log('a note');
        return load();
      },
    });
    expect(printed()).toMatch(/^a note\n# cannon plan — /);
  });

  it('a removed step whose effect is live: drift, explained, conflicting orphan, exit 2', async () => {
    const raw = def('plan-orphan', {
      invoke: {
        setDelayInit: { target: ['fixture'], func: 'setDelay', args: ['0'] },
        setDelayTuned: { target: ['fixture'], func: 'setDelay', args: ['7'], depends: ['invoke.setDelayInit'] },
        setValue: { target: ['fixture'], func: 'setValue', args: ['42'] },
      },
    });
    const b = await buildFixtureRecord(url, raw);
    const record: DeploymentInfo = JSON.parse(JSON.stringify(b.record));
    delete (record.def as any).invoke.setDelayTuned; // the state keeps the step: it is now an orphan

    const { chain, pub, wallet } = fixtureClients(url, CHAIN_ID);
    const hash = await wallet.writeContract({
      address: b.addresses.fixture,
      abi,
      functionName: 'setValue',
      args: [99n],
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });

    const { report, exitCode } = await plan(options(), { loadRecord: loaded({ ...b, record }) });
    const row = (step: string) => report.steps.find((s) => s.step === step);

    expect(row('invoke.setValue')?.status).toBe('drift');
    expect(row('invoke.setDelayInit')).toMatchObject({ status: 'drift', explainedBy: 'invoke.setDelayTuned' });
    expect(row('invoke.setDelayTuned')).toMatchObject({ status: 'orphan', orphan: { conflicting: true } });
    expect(exitCode).toBe(2);
  });

  it('--block pins the checks: a change made after that block is not seen', async () => {
    const b = await buildFixtureRecord(url, def('plan-block'));
    const { chain, pub, wallet } = fixtureClients(url, CHAIN_ID);
    const before = await pub.getBlockNumber();
    const hash = await wallet.writeContract({
      address: b.addresses.fixture,
      abi,
      functionName: 'setValue',
      args: [99n],
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });

    const pinned = await plan(options({ block: before }), { loadRecord: loaded(b) });
    expect(pinned.exitCode).toBe(0);
    expect(pinned.report.block).toBe(before.toString());

    const latest = await plan(options(), { loadRecord: loaded(b) });
    expect(latest.exitCode).toBe(2);
    expect(BigInt(latest.report.block)).toBeGreaterThan(before);
  });

  it('--cannonfile: a step the file adds is pending "added", exit 2', async () => {
    const storage = fixtureStorage();
    const raw = def('plan-pending');
    const b = await buildFixtureRecord(url, raw, storage);
    const file = path.join(tmp, 'cannonfile.toml');
    await fs.writeFile(
      file,
      [
        'name = "plan-pending"',
        'version = "1.0.0"',
        '[deploy.fixture]',
        'artifact = "PlanFixture"',
        `args = ["${OWNER}"]`,
        '[invoke.setValue]',
        'target = ["fixture"]',
        'func = "setValue"',
        'args = ["42"]',
        '[invoke.setLimit]',
        'target = ["fixture"]',
        'func = "setLimit"',
        'args = ["7", "5"]',
        '',
      ].join('\n')
    );

    const { report, exitCode } = await plan(options({ cannonfile: file }), {
      loadRecord: loaded(b),
      storage: { registry: storage.registry, loaders: { ipfs: storage.loader } },
    });

    expect(report.pending).toEqual([{ step: 'invoke.setLimit', change: 'added' }]);
    expect(exitCode).toBe(2);
    expect(printed()).toContain('## Will change');
  });

  it('--out writes plan.json and plan.md into a directory it creates, and still prints to stdout', async () => {
    const b = await buildFixtureRecord(url, def('plan-out'));
    const out = path.join(tmp, 'nested', 'out');
    const { report } = await plan(options({ out }), { loadRecord: loaded(b) });

    const json = JSON.parse(await fs.readFile(path.join(out, 'plan.json'), 'utf8'));
    expect(json.version).toBe(1);
    expect(json.steps).toEqual(report.steps);
    expect(await fs.readFile(path.join(out, 'plan.md'), 'utf8')).toMatch(/^# cannon plan — plan-test:1\.0\.0@main\n/);
    expect(printed()).toMatch(/^# cannon plan/);
  });

  it('refuses when the RPC is another chain than the record', async () => {
    const b = await buildFixtureRecord(url, def('plan-chain'));
    await expect(plan(options(), { loadRecord: loaded(b, { chainId: 1 }) })).rejects.toThrow(
      `the RPC at the given URL is chain ${CHAIN_ID}, but the package is deployed on chain 1`
    );
    expect(printed()).toBe('');
  });

  it('rows of a hints enumeration follow the walk rows and every order is its index', async () => {
    const b = await buildFixtureRecord(url, def('plan-enum'));
    const hints = path.join(tmp, 'hints.cjs');
    await fs.writeFile(
      hints,
      `module.exports = { enumerations: [
        async ({ results, read }) => {
          const value = await read(results[0].target.address, 'function getValue() view returns (uint256)', []);
          return [{ pkg: 'root', step: 'enum.seen:' + results.length + ':' + value, kind: 'enum', status: 'unchecked' }];
        },
        async () => [{ pkg: 'root', step: 'enum.second', kind: 'enum', status: 'unchecked' }],
      ] };`
    );

    const { report } = await plan(options({ hints }), { loadRecord: loaded(b) });

    expect(report.steps.map((s) => s.step)).toEqual(['deploy.fixture', 'invoke.setValue', 'enum.seen:2:42', 'enum.second']);
    expect(report.steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  it('a failing enumeration is one error row; the other enumerations and the report stand', async () => {
    const b = await buildFixtureRecord(url, def('plan-enum-fail'));
    const hints = path.join(tmp, 'hints-enum-fail.cjs');
    await fs.writeFile(
      hints,
      `module.exports = { enumerations: [
        async () => { throw new Error('rate limited'); },
        async () => 'not rows',
        async () => [null],
        async () => [{ pkg: 'root', step: 'enum.good', kind: 'enum', status: 'unchecked' }],
      ] };`
    );

    const { report, exitCode } = await plan(options({ hints }), { loadRecord: loaded(b) });

    expect(report.steps.slice(2)).toEqual([
      {
        pkg: 'plan-test:1.0.0@main',
        step: '(enumeration 0)',
        kind: 'enumeration',
        status: 'error',
        order: 2,
        detail: 'rate limited',
      },
      {
        pkg: 'plan-test:1.0.0@main',
        step: '(enumeration 1)',
        kind: 'enumeration',
        status: 'error',
        order: 3,
        detail: 'an enumeration must return an array of rows',
      },
      {
        pkg: 'plan-test:1.0.0@main',
        step: '(enumeration 2)',
        kind: 'enumeration',
        status: 'error',
        order: 4,
        detail: 'an enumeration must return an array of rows',
      },
      { pkg: 'root', step: 'enum.good', kind: 'enum', status: 'unchecked', order: 5 },
    ]);
    expect(report.steps.slice(0, 2).map((s) => [s.step, s.status])).toEqual([
      ['deploy.fixture', 'in-sync'],
      ['invoke.setValue', 'in-sync'],
    ]);
    expect(exitCode).toBe(0);
  });

  it('--no-bytecode drops the bytecode row', async () => {
    const b = await buildFixtureRecord(url, def('plan-flags'));
    const { report } = await plan(options({ bytecode: false }), { loadRecord: loaded(b) });
    expect(report.steps.map((s) => s.step)).toEqual(['invoke.setValue']);
  });

  it('--depth limits how far into cloned packages the walk goes', async () => {
    const storage = fixtureStorage();
    await buildFixtureRecord(url, def('plan-depth-child'), storage);
    const b = await buildFixtureRecord(
      url,
      {
        name: 'plan-depth',
        version: '1.0.0',
        clone: { x: { source: 'plan-depth-child:1.0.0', target: 'plan-depth-cloned:1.0.0' } },
      },
      storage
    );

    const pkgs = async (depth?: number) =>
      (await plan(options({ depth }), { loadRecord: loaded(b) })).report.steps.map((s) => s.pkg);

    // the parent declares no step of its own: every row comes from the cloned package
    expect(await pkgs()).toEqual(['plan-test:1.0.0@main.x', 'plan-test:1.0.0@main.x']);
    expect(await pkgs(0)).toEqual([]);
  });

  it('is read-only: no wallet client, no account from a key, and the command has no key option', async () => {
    const wallet = jest.spyOn(viem, 'createWalletClient');
    const account = jest.spyOn(viemAccounts, 'privateKeyToAccount');
    const b = await buildFixtureRecord(url, def('plan-readonly'));
    wallet.mockClear();
    account.mockClear();

    await plan(options(), { loadRecord: loaded(b) });
    expect(wallet).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();

    // the cannonfile (pending runtime) and hints (their reads) paths create no signer either
    const storage = fixtureStorage();
    const withFile = await buildFixtureRecord(url, def('plan-readonly-file'), storage);
    const file = path.join(tmp, 'readonly.toml');
    await fs.writeFile(
      file,
      [
        'name = "plan-readonly-file"',
        'version = "1.0.0"',
        '[deploy.fixture]',
        'artifact = "PlanFixture"',
        `args = ["${OWNER}"]`,
        '[invoke.setValue]',
        'target = ["fixture"]',
        'func = "setValue"',
        'args = ["43"]',
        '',
      ].join('\n')
    );
    const hints = path.join(tmp, 'readonly-hints.cjs');
    await fs.writeFile(
      hints,
      `module.exports = {
        checks: { setValue: async ({ read, address }) => { await read(address, 'getValue() view returns (uint256)', []); return null; } },
        enumerations: [async ({ results, read }) => { await read(results[0].target.address, 'getValue() view returns (uint256)', []); return []; }],
      };`
    );
    wallet.mockClear();
    account.mockClear();
    const run = await plan(options({ cannonfile: file, hints }), {
      loadRecord: loaded(withFile),
      storage: { registry: storage.registry, loaders: { ipfs: storage.loader } },
    });
    expect(run.report.pending).toEqual([{ step: 'invoke.setValue', change: 'changed' }]);
    expect(wallet).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();
    const flags = (commandsConfig.plan.options ?? []).map((o) => o.flags);
    expect(flags.length).toBeGreaterThan(5);
    expect(flags.filter((f) => /key|signer|sender/i.test(f))).toEqual([]);
  });
});
