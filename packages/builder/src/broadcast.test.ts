import * as viem from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { createNonceManager, jsonRpc } from 'viem/nonce';
import { broadcastTransaction, DEFAULT_BROADCAST_POLICY, parseGasLimit } from './broadcast';
import type { CannonSigner } from './types';

const CHAIN: viem.Chain = { ...mainnet, id: 6343 };
const PRIVATE_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TX_HASH = `0x${'ab'.repeat(32)}` as viem.Hash;
const TARGET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as viem.Address;

// The RPC keeps answering a stale pending nonce (5) no matter what was already sent. This is the
// strict-ordering / lagging-replica behaviour from issue #1875 that the pipeline has to survive.
const STALE_NONCE = '0x5';

type Harness = {
  signer: CannonSigner;
  provider: viem.PublicClient;
  calls: Record<string, number>;
  sendErrors: Error[];
  consume: jest.Mock;
  reset: jest.Mock;
  signedNonces: () => number[];
  signedTxns: () => viem.TransactionSerializableGeneric[];
  receipts: viem.Hash[];
};

function makeHarness(opts: { jsonRpcAccount?: boolean } = {}): Harness {
  const calls: Record<string, number> = {};
  const sendErrors: Error[] = [];
  const receipts: viem.Hash[] = [];

  // retryCount: 0 — viem's transport-level retry would otherwise swallow the injected failures
  const transport = viem.custom(
    {
      async request({ method }: { method: string }) {
        calls[method] = (calls[method] ?? 0) + 1;
        switch (method) {
          case 'eth_chainId':
            return viem.numberToHex(CHAIN.id);
          case 'eth_getTransactionCount':
            return STALE_NONCE;
          case 'eth_estimateGas':
            return '0x5208';
          case 'eth_getBlockByNumber':
            return {
              baseFeePerGas: '0x1',
              number: '0x1',
              gasLimit: '0x1',
              gasUsed: '0x0',
              timestamp: '0x0',
              transactions: [],
            };
          case 'eth_maxPriorityFeePerGas':
            return '0x1';
          case 'eth_sendRawTransaction':
          case 'eth_sendTransaction': {
            const err = sendErrors.shift();
            if (err) throw err;
            return TX_HASH;
          }
          default:
            throw new Error(`unexpected rpc method ${method}`);
        }
      },
    },
    { retryCount: 0 }
  );

  const manager = createNonceManager({ source: jsonRpc() });
  const consume = jest.fn((args: Parameters<viem.NonceManager['consume']>[0]) => manager.consume(args));
  const reset = jest.fn((args: Parameters<viem.NonceManager['reset']>[0]) => manager.reset(args));
  const account = privateKeyToAccount(PRIVATE_KEY, { nonceManager: { ...manager, consume, reset } });
  const signTransaction = jest.spyOn(account, 'signTransaction');

  const wallet = viem.createWalletClient({ account: opts.jsonRpcAccount ? TARGET : account, chain: CHAIN, transport });

  const provider = viem.createPublicClient({ chain: CHAIN, transport }).extend(() => ({
    waitForTransactionReceipt: async ({ hash }: { hash: viem.Hash }) => {
      receipts.push(hash);
      return { transactionHash: hash, status: 'success' } as viem.TransactionReceipt;
    },
  }));

  return {
    signer: { address: wallet.account.address, wallet },
    provider,
    calls,
    sendErrors,
    consume,
    reset,
    signedNonces: () => signTransaction.mock.calls.map(([tx]) => Number(tx.nonce)),
    signedTxns: () => signTransaction.mock.calls.map(([tx]) => tx as viem.TransactionSerializableGeneric),
    receipts,
  };
}

describe('broadcast.ts', () => {
  describe('parseGasLimit()', () => {
    it('returns undefined when no gas limit is configured', () => {
      expect(parseGasLimit(undefined)).toBeUndefined();
      expect(parseGasLimit('')).toBeUndefined();
    });

    it('parses a decimal gas limit string', () => {
      expect(parseGasLimit('3000000')).toBe(BigInt(3000000));
    });
  });

  describe('broadcastTransaction()', () => {
    const request = { to: TARGET, data: '0x' as viem.Hex, value: BigInt(0) };
    const fastPolicy = { retries: 3, minTimeout: 1, factor: 1 };

    it('has a default policy of 3 retries with backoff', () => {
      expect(DEFAULT_BROADCAST_POLICY).toEqual({ retries: 3, minTimeout: 250, factor: 2 });
    });

    it('assigns the nonce through the account nonce manager at send time', async () => {
      const h = makeHarness();

      const receipt = await broadcastTransaction({ signer: h.signer, provider: h.provider, policy: fastPolicy }, request);

      expect(receipt.transactionHash).toBe(TX_HASH);
      expect(h.receipts).toEqual([TX_HASH]);
      expect(h.consume).toHaveBeenCalledTimes(1);
      // the only pending-nonce read belongs to the manager; prepareTransactionRequest must not fetch one itself
      expect(h.calls.eth_getTransactionCount).toBe(1);
      expect(h.signedNonces()).toEqual([5]);
      expect(h.calls.eth_sendRawTransaction).toBe(1);
    });

    it('resets the nonce manager and re-sends with the next nonce after a failed broadcast', async () => {
      const h = makeHarness();
      h.sendErrors.push(new Error('rpc glitch'));
      const onRetry = jest.fn();

      await broadcastTransaction({ signer: h.signer, provider: h.provider, policy: fastPolicy, onRetry }, request);

      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.consume).toHaveBeenCalledTimes(2);
      // the RPC still answers 5, but the manager never regresses below the nonce it already handed out
      expect(h.signedNonces()).toEqual([5, 6]);
      expect(h.calls.eth_sendRawTransaction).toBe(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, 4, expect.any(Error));
    });

    it('sends exactly once when retries is 0', async () => {
      const h = makeHarness();
      h.sendErrors.push(new Error('rpc glitch'));
      const onRetry = jest.fn();

      await expect(
        broadcastTransaction(
          { signer: h.signer, provider: h.provider, policy: { ...fastPolicy, retries: 0 }, onRetry },
          request
        )
      ).rejects.toThrow('rpc glitch');

      expect(h.calls.eth_sendRawTransaction).toBe(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it('does not retry when the user rejected the request', async () => {
      const h = makeHarness();
      h.sendErrors.push(new viem.UserRejectedRequestError(new Error('user said no')));

      await expect(
        broadcastTransaction({ signer: h.signer, provider: h.provider, policy: fastPolicy }, request)
      ).rejects.toThrow('User rejected the request');

      expect(h.calls.eth_sendRawTransaction).toBe(1);
      expect(h.reset).not.toHaveBeenCalled();
    });

    it('surfaces the last error once retries are exhausted', async () => {
      const h = makeHarness();
      h.sendErrors.push(new Error('first'), new Error('second'), new Error('third'), new Error('fourth'));
      const onRetry = jest.fn();

      await expect(
        broadcastTransaction({ signer: h.signer, provider: h.provider, policy: fastPolicy, onRetry }, request)
      ).rejects.toThrow('fourth');

      expect(h.calls.eth_sendRawTransaction).toBe(4);
      expect(onRetry).toHaveBeenCalledTimes(3);
      expect(h.receipts).toEqual([]);
    });

    it('retries json-rpc backed signers, which have no nonce manager to reset', async () => {
      const h = makeHarness({ jsonRpcAccount: true });
      h.sendErrors.push(new Error('rpc glitch'));

      const receipt = await broadcastTransaction({ signer: h.signer, provider: h.provider, policy: fastPolicy }, request);

      expect(receipt.transactionHash).toBe(TX_HASH);
      expect(h.calls.eth_sendTransaction).toBe(2);
      expect(h.calls.eth_sendRawTransaction).toBeUndefined();
      expect(h.reset).not.toHaveBeenCalled();
    });

    it('passes explicit gas and EIP-1559 fees through to the signed transaction', async () => {
      const h = makeHarness();

      await broadcastTransaction(
        { signer: h.signer, provider: h.provider, policy: fastPolicy },
        { ...request, gas: BigInt(123456), maxFeePerGas: BigInt(77), maxPriorityFeePerGas: BigInt(7) }
      );

      const [signed] = h.signedTxns();
      expect(signed.gas).toBe(BigInt(123456));
      expect(signed.maxFeePerGas).toBe(BigInt(77));
      expect(signed.maxPriorityFeePerGas).toBe(BigInt(7));
      expect(h.calls.eth_estimateGas).toBeUndefined();
    });

    it('sends a legacy transaction when gasPrice is given', async () => {
      const h = makeHarness();

      await broadcastTransaction(
        { signer: h.signer, provider: h.provider, policy: fastPolicy },
        { ...request, gasPrice: BigInt(9) }
      );

      const [signed] = h.signedTxns();
      expect(signed.type).toBe('legacy');
      expect(signed.gasPrice).toBe(BigInt(9));
    });
  });
});
