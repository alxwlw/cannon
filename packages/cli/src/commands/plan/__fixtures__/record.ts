import _ from 'lodash';
import * as viem from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  build,
  CannonLoader,
  CannonSigner,
  ChainBuilderRuntime,
  ChainDefinition,
  ContractArtifact,
  createInitialContext,
  DeploymentInfo,
  getContentUrl,
  InMemoryRegistry,
  RawChainDefinition,
} from '@usecannon/builder';
import fixture from './PlanFixture.json';

// Test-only. anvil's public test mnemonic: its first account is funded on every local anvil. Production code of
// `cannon plan` never signs; only these fixtures do, to build a record and to change chain state under a test.
export const FIXTURE_ACCOUNT = mnemonicToAccount('test test test test test test test test test test test junk');

/**
 * An in-memory blob store whose URLs are the `ipfs://` content ids an IPFS node would return. The builder's
 * `InMemoryLoader` returns `mem://` URLs, and `clone` refuses those: it checks the misc URL it computes with
 * `getContentUrl` against the URL the store returns.
 */
export class ContentLoader implements CannonLoader {
  private readonly blobs = new Map<string, string>();

  getLabel() {
    return 'fixture memory';
  }

  async read(url: string) {
    const blob = this.blobs.get(url);
    return blob === undefined ? null : JSON.parse(blob);
  }

  async put(misc: unknown) {
    const url = await getContentUrl(misc);
    if (url) this.blobs.set(url, JSON.stringify(misc));
    return url;
  }
}

/** Registry and blob store shared by several builds, so one fixture package can `pull` or `clone` another. */
export interface FixtureStorage {
  registry: InMemoryRegistry;
  loader: ContentLoader;
}

export function fixtureStorage(): FixtureStorage {
  return { registry: new InMemoryRegistry(), loader: new ContentLoader() };
}

/**
 * A public and a wallet client on the test account. Receipt waits poll every 50 ms: viem leaves the last poll's
 * timer running after a receipt resolves, and at the 4 s default that timer keeps a jest worker alive past teardown.
 */
export function fixtureClients(
  rpcUrl: string,
  chainId: number
): {
  chain: viem.Chain;
  pub: viem.PublicClient<viem.Transport, viem.Chain>;
  wallet: viem.WalletClient<viem.Transport, viem.Chain, viem.HDAccount>;
} {
  const chain = viem.defineChain({
    id: chainId,
    name: 'local',
    nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = viem.http(rpcUrl);
  return {
    chain,
    pub: viem.createPublicClient({ chain, transport, pollingInterval: 50 }),
    wallet: viem.createWalletClient({ account: FIXTURE_ACCOUNT, chain, transport, pollingInterval: 50 }),
  };
}

const artifact: ContractArtifact = { ...fixture, abi: fixture.abi as viem.Abi, bytecode: fixture.bytecode as viem.Hex };

/**
 * Builds `rawDef` with the builder's own `build()` against the node at `rpcUrl`, the way `cannon build` does:
 * misc stored through the runtime, the record put in the blob store and published under `name:version@preset`.
 */
export async function buildFixtureRecord(
  rpcUrl: string,
  rawDef: RawChainDefinition,
  storage: FixtureStorage = fixtureStorage()
): Promise<{ record: DeploymentInfo; readBlob: (url: string) => Promise<any>; addresses: Record<string, viem.Address> }> {
  const chainId = await viem.createPublicClient({ transport: viem.http(rpcUrl) }).getChainId();
  const { pub: provider, wallet } = fixtureClients(rpcUrl, chainId);
  const signer: CannonSigner = { wallet, address: FIXTURE_ACCOUNT.address };

  const runtime = new ChainBuilderRuntime(
    {
      provider,
      chainId,
      snapshots: false,
      allowPartialDeploy: false,
      async getSigner(addr) {
        if (!viem.isAddressEqual(addr, signer.address)) throw new Error(`no test signer for ${addr}`);
        return signer;
      },
      getDefaultSigner: async () => signer,
      async getArtifact(name) {
        if (name !== artifact.contractName) throw new Error(`no fixture artifact ${name}`);
        return _.cloneDeep(artifact);
      },
    },
    storage.registry,
    { ipfs: storage.loader },
    'ipfs'
  );

  const def = new ChainDefinition(rawDef);
  const state = await build(runtime, def, {}, await createInitialContext(def, {}, chainId, {}));
  const miscUrl = await runtime.recordMisc();
  if (!miscUrl) throw new Error('fixture misc was not stored');

  const url = await runtime.putDeploy({
    generator: 'cannon plan-fixture',
    timestamp: Math.floor(Date.now() / 1000),
    def: rawDef,
    options: {},
    status: 'complete',
    state,
    meta: {},
    miscUrl,
    chainId,
  });
  if (!url) throw new Error('fixture record was not stored');
  await storage.registry.publish([`${rawDef.name}:${rawDef.version}@${rawDef.preset ?? 'main'}`], chainId, url);
  // the record as a reader loads it: stored as JSON, so event arguments are decimal strings, not the bigints of
  // the in-memory state `build()` returned
  const record: DeploymentInfo | null = await runtime.readBlob(url);
  if (!record) throw new Error('fixture record cannot be read back');

  const addresses: Record<string, viem.Address> = {};
  for (const step of Object.values(state)) {
    for (const [name, c] of Object.entries(step.artifacts.contracts ?? {})) addresses[name] = c.address;
  }
  return { record, readBlob: (u: string) => runtime.readBlob(u), addresses };
}
