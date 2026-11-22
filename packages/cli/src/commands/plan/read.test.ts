import * as viem from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CannonRpcNode, runRpc } from '../../rpc';
import fixture from './__fixtures__/PlanFixture.json';
import { createChainReader } from './read';

const CHAIN_ID = 13370;
// anvil's well-known first dev key: test-only, used by this test and never by production code
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('createChainReader', () => {
  let node: CannonRpcNode;
  let url: string;
  const account = privateKeyToAccount(TEST_KEY);
  // receipt waits poll every 50 ms: viem leaves the last poll's timer running after a receipt resolves, and at the
  // 4 s default that timer keeps the jest worker alive past teardown
  let wallet: viem.WalletClient<viem.Transport, viem.Chain, typeof account>;
  let pub: viem.PublicClient<viem.Transport, viem.Chain>;
  const abi = fixture.abi as viem.Abi;
  let address: viem.Address;
  let deployHash: viem.Hex;

  const send = async (functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  };

  beforeAll(async () => {
    // port 0: anvil picks a free port, so a run never collides with a stray node of an earlier one
    node = await runRpc({ port: 0, chainId: CHAIN_ID });
    url = node.host;
    const chain = viem.defineChain({
      id: CHAIN_ID,
      name: 'local',
      nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    });
    wallet = viem.createWalletClient({ account, chain, transport: viem.http(url), pollingInterval: 50 });
    pub = viem.createPublicClient({ chain, transport: viem.http(url), pollingInterval: 50 });
    deployHash = await wallet.deployContract({
      abi,
      bytecode: fixture.bytecode as viem.Hex,
      args: [account.address],
    });
    address = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
  }, 60000);

  afterAll(async () => {
    if (!node) return;
    const exited = new Promise((resolve) => node.once('exit', resolve));
    node.kill('SIGTERM');
    await exited;
  });

  const getValue = abi.find((f) => f.type === 'function' && f.name === 'getValue') as viem.AbiFunction;

  it('reads at the block resolved at creation, not at the head', async () => {
    await send('setValue', [1n]);
    const reader = await createChainReader(url);
    await send('setValue', [2n]);
    expect(await reader.call(address, getValue, [])).toBe(1n);
    expect(await pub.readContract({ address, abi, functionName: 'getValue' })).toBe(2n);
    expect(reader.blockNumber).toBe((await pub.getBlockNumber()) - 1n);
  });

  it('honours an explicit block', async () => {
    const reader = await createChainReader(url, { block: await pub.getBlockNumber() });
    expect(await reader.call(address, getValue, [])).toBe(2n);
    const earlier = await createChainReader(url, { block: reader.blockNumber - 1n });
    expect(await earlier.call(address, getValue, [])).toBe(1n);
  });

  it('refuses a block above the chain head', async () => {
    const head = await pub.getBlockNumber();
    await expect(createChainReader(url, { block: head + 100n })).rejects.toThrow(
      `block ${head + 100n} is above the chain head (${head})`
    );
    expect((await createChainReader(url, { block: head })).blockNumber).toBe(head);
  });

  it('getCode returns the runtime code, and undefined where there is none', async () => {
    const reader = await createChainReader(url);
    expect(await reader.getCode(address)).toBe(fixture.deployedBytecode);
    expect(await reader.getCode(account.address)).toBeUndefined();
  });

  it('getTransaction returns the target and input', async () => {
    const hash = await send('setValue', [3n]);
    const reader = await createChainReader(url);
    const tx = await reader.getTransaction(hash);
    expect(tx.to).toBe(address);
    expect(tx.input).toBe(viem.encodeFunctionData({ abi, functionName: 'setValue', args: [3n] }));
    const deploy = await reader.getTransaction(deployHash);
    expect(deploy.to).toBeNull();
  });
});
