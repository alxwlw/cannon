import * as viem from 'viem';

/** The only door to the chain: read-only, and pinned to one block so a whole report describes one state. */
export interface ChainReader {
  readonly blockNumber: bigint;
  call(address: viem.Address, fn: viem.AbiFunction, args: unknown[]): Promise<unknown>;
  getCode(address: viem.Address): Promise<viem.Hex | undefined>;
  getTransaction(hash: viem.Hex): Promise<{ to: viem.Address | null; input: viem.Hex }>;
}

export async function createChainReader(rpcUrl: string, opts: { block?: bigint } = {}): Promise<ChainReader> {
  const client = viem.createPublicClient({
    transport: viem.http(rpcUrl, { batch: { batchSize: 40, wait: 20 }, retryCount: 4, timeout: 60000 }),
  });
  const blockNumber = opts.block ?? (await client.getBlockNumber());

  return {
    blockNumber,
    call: (address, fn, args) =>
      client.readContract({ address, abi: [fn], functionName: fn.name, args, blockNumber }) as Promise<unknown>,
    async getCode(address) {
      const code = await client.getCode({ address, blockNumber });
      return code && code !== '0x' ? code : undefined;
    },
    async getTransaction(hash) {
      const tx = await client.getTransaction({ hash });
      return { to: tx.to ?? null, input: tx.input };
    },
  };
}
