import * as viem from 'viem';
import { CannonRpcNode, runRpc } from '../../rpc';
import { buildFixtureRecord, fixtureStorage } from './__fixtures__/record';
import { plan, PlanOptions } from './index';

const CHAIN_ID = 13370;
const OWNER = viem.getAddress('0x0000000000000000000000000000000000000b0b');

const mockGetPackageInfo = jest.fn();
jest.mock('../../helpers', () => ({
  ...jest.requireActual('../../helpers'),
  getPackageInfo: (...a: unknown[]) => mockGetPackageInfo(...a),
}));
const mockRegistry = jest.fn();
jest.mock('../../registry', () => ({ createDefaultReadRegistry: (...a: unknown[]) => mockRegistry(...a) }));
const mockLoader = jest.fn();
jest.mock('../../loader', () => ({ getMainLoader: (...a: unknown[]) => mockLoader(...a) }));

describe('plan() default record loader', () => {
  let node: CannonRpcNode;
  let url: string;
  let storage: ReturnType<typeof fixtureStorage>;
  let parent: Awaited<ReturnType<typeof buildFixtureRecord>>;
  let loads: string[];

  const options = (): PlanOptions => ({ packageRef: 'plan-default:1.0.0', rpcUrl: url, bytecode: true, json: false });
  const nestedRows = (r: { report: { steps: { pkg: string }[] } }) => r.report.steps.map((s) => s.pkg);

  beforeAll(async () => {
    node = await runRpc({ port: 0, chainId: CHAIN_ID });
    url = node.host;
    storage = fixtureStorage();
    await buildFixtureRecord(
      url,
      {
        name: 'plan-default-child',
        version: '1.0.0',
        deploy: { fixture: { artifact: 'PlanFixture', args: [OWNER] } },
      },
      storage
    );
    parent = await buildFixtureRecord(
      url,
      {
        name: 'plan-default',
        version: '1.0.0',
        clone: { x: { source: 'plan-default-child:1.0.0', target: 'plan-default-cloned:1.0.0' } },
      },
      storage
    );
  }, 60000);

  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    loads = [];
    mockGetPackageInfo.mockReset().mockResolvedValue({
      fullPackageRef: 'plan-default:1.0.0@main',
      chainId: CHAIN_ID,
      ipfsUrl: 'ipfs://unused',
      deployInfo: parent.record,
    });
    mockRegistry.mockReset().mockResolvedValue(storage.registry);
    mockLoader.mockReset().mockReturnValue({
      ipfs: {
        getLabel: () => 'counting',
        read: (u: string) => {
          loads.push(u);
          return storage.loader.read(u);
        },
        put: (m: unknown) => storage.loader.put(m),
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (!node) return;
    const exited = new Promise((resolve) => node.once('exit', resolve));
    node.kill('SIGTERM');
    await exited;
  });

  it('with injected storage: the record comes from getPackageInfo, nested blobs from the injected loader', async () => {
    const seen: string[] = [];
    const loader = {
      getLabel: () => 'injected',
      read: (u: string) => {
        seen.push(u);
        return storage.loader.read(u);
      },
      put: (m: unknown) => storage.loader.put(m),
    };
    const result = await plan(options(), { storage: { registry: storage.registry, loaders: { ipfs: loader } } });

    expect(mockGetPackageInfo).toHaveBeenCalledWith('plan-default:1.0.0', undefined, url);
    expect(nestedRows(result)).toEqual(['plan-default:1.0.0@main.x']);
    expect(seen.length).toBeGreaterThan(0);
    expect(mockRegistry).not.toHaveBeenCalled();
    expect(mockLoader).not.toHaveBeenCalled();
  });

  it('without storage: the CLI registry and main loader are used for nested blobs', async () => {
    const result = await plan(options());

    expect(nestedRows(result)).toEqual(['plan-default:1.0.0@main.x']);
    expect(mockRegistry).toHaveBeenCalledTimes(1);
    expect(mockLoader).toHaveBeenCalledTimes(1);
    expect(loads.length).toBeGreaterThan(0);
  });
});
