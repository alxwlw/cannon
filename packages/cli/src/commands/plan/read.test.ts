import * as viem from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CannonRpcNode, runRpc } from '../../rpc';
import fixture from './__fixtures__/PlanFixture.json';
import { createChainReader } from './read';

const PORT = 8591;
const CHAIN_ID = 13370;
// anvil's well-known first dev key: test-only, used by this test and never by production code
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('createChainReader', () => {
  let node: CannonRpcNode;
  const url = `http://127.0.0.1:${PORT}`;
  const chain = viem.defineChain({
    id: CHAIN_ID,
    name: 'local',
    nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const account = privateKeyToAccount(TEST_KEY);
  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(url) });
  const pub = viem.createPublicClient({ chain, transport: viem.http(url) });
  const abi = fixture.abi as viem.Abi;
  let address: viem.Address;
  let deployHash: viem.Hex;

  const send = async (functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, chain });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  };

  beforeAll(async () => {
    node = await runRpc({ port: PORT, chainId: CHAIN_ID });
    deployHash = await wallet.deployContract({
      abi,
      bytecode: fixture.bytecode as viem.Hex,
      args: [account.address],
      chain,
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
