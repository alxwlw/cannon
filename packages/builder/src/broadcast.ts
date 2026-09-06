import Debug from 'debug';
import promiseRetry from 'promise-retry';
import * as viem from 'viem';
import type { CannonSigner } from './types';

const debug = Debug('cannon:builder:broadcast');

export type BroadcastPolicy = {
  // number of re-sends after the first failed attempt; 0 disables retries
  retries: number;
  // delay before the first retry, in milliseconds
  minTimeout: number;
  // exponential backoff factor applied between retries
  factor: number;
};

export const DEFAULT_BROADCAST_POLICY: BroadcastPolicy = { retries: 3, minTimeout: 250, factor: 2 };

// fee fields mirror viem's discriminated request type: a transaction is either legacy (gasPrice) or
// EIP-1559 (maxFeePerGas / maxPriorityFeePerGas), never both
export type BroadcastFees =
  | { gasPrice?: bigint; maxFeePerGas?: undefined; maxPriorityFeePerGas?: undefined }
  | { gasPrice?: undefined; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

// account, chain and nonce belong to the pipeline; callers never set them. `to` is null for contract
// creation, matching viem's TransactionRequest.
export type BroadcastRequestBase = {
  to?: viem.Address | null;
  data?: viem.Hex;
  value?: bigint;
  gas?: bigint;
};

export type BroadcastRequest = BroadcastRequestBase & BroadcastFees;

export type BroadcastContext = {
  signer: CannonSigner;
  provider: viem.PublicClient;
  policy?: BroadcastPolicy;
  // called before each retry (never after the final failure)
  onRetry?: (attempt: number, maxAttempts: number, err: unknown) => void;
};

// everything viem fills in by default except the nonce: leaving it out of the provider-side prepare
// means `wallet.sendTransaction` assigns it through the account's nonce manager right before signing.
// The manager re-reads the pending count on every send and never hands out a nonce lower than the
// last one it issued (its nonceMap floor), so a retry always signs with the next nonce and a stale
// replica answering an already-used count is harmless. Limitation: if the earlier attempt never
// actually reached the mempool, the retry still advances past it, leaving a nonce gap behind — see
// the doc comment on broadcastTransaction below.
const PREPARE_PARAMETERS: viem.PrepareTransactionRequestParameterType[] = ['chainId', 'fees', 'gas', 'type'];

// cannonfile `overrides.gasLimit` is a decimal string; viem expects `gas` as a bigint
export function parseGasLimit(gasLimit: string | undefined): bigint | undefined {
  if (!gasLimit) return undefined;
  if (!/^\d+$/.test(gasLimit)) {
    throw new Error(`overrides.gasLimit must be a non-negative integer string, got "${gasLimit}"`);
  }
  return BigInt(gasLimit);
}

// viem types the request as a discriminated union on the fee model, so the fee fields are attached
// per branch instead of being spread blindly
function toPrepareParameters(
  request: BroadcastRequest,
  account: viem.Account | viem.Address,
  chain: viem.Chain | undefined
) {
  const base = {
    account,
    chain,
    to: request.to,
    data: request.data,
    value: request.value,
    gas: request.gas,
    parameters: PREPARE_PARAMETERS,
  };
  if (request.gasPrice !== undefined) {
    return { ...base, type: 'legacy' as const, gasPrice: request.gasPrice };
  }
  if (request.maxFeePerGas !== undefined || request.maxPriorityFeePerGas !== undefined) {
    return {
      ...base,
      type: 'eip1559' as const,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    };
  }
  return base;
}

function isUserRejection(err: unknown): boolean {
  return err instanceof viem.BaseError && !!err.walk((e) => e instanceof viem.UserRejectedRequestError);
}

// Sends one transaction through the single live-broadcast path of the builder: prepare everything but
// the nonce on the provider, hand the request to the signer's wallet, and retry any failure with
// backoff. The nonce is intentionally left out of the prepare so viem assigns it through the account's
// nonce manager right before signing (see the comment above PREPARE_PARAMETERS): the manager re-reads
// the pending count on every send and never regresses below the last nonce it issued, so a retry
// always signs the next nonce even if the RPC keeps answering a stale, already-used count.
// Deterministic failures (reverts) fail identically on each attempt and surface the last error. The
// one exception is an explicit user rejection (EIP-1193 code 4001), which is never retried.
//
// Known limitation: "always retry" assumes the failed attempt reached the mempool (or the RPC replica
// was merely stale). If it did not — e.g. a fee below the current base fee, or an RPC 429/5xx after
// viem's own transport retries are exhausted — the retry still signs the next nonce, leaving a gap
// behind it. `waitForTransactionReceipt` then times out (viem's default is 180s), and the earlier,
// never-broadcast transaction only executes on a later `cannon build` once a fresh nonce manager
// reuses the gapped nonce — a delayed second execution of that step. `--broadcast-retries 0` opts out
// of retrying altogether. Resolves with the receipt once the transaction is mined.
export async function broadcastTransaction(
  ctx: BroadcastContext,
  request: BroadcastRequest
): Promise<viem.TransactionReceipt> {
  const { signer, provider } = ctx;
  const policy = ctx.policy ?? DEFAULT_BROADCAST_POLICY;
  const maxAttempts = policy.retries + 1;
  const account = signer.wallet.account ?? signer.address;

  const hash = await promiseRetry(
    { retries: policy.retries, minTimeout: policy.minTimeout, factor: policy.factor },
    async (retry, attempt) => {
      try {
        const prepared = await provider.prepareTransactionRequest(toPrepareParameters(request, account, provider.chain));
        return await signer.wallet.sendTransaction({ ...prepared, account, chain: signer.wallet.chain });
      } catch (err) {
        if (isUserRejection(err)) throw err;

        debug(`broadcast attempt ${attempt}/${maxAttempts} failed:`, err);

        if (attempt < maxAttempts) ctx.onRetry?.(attempt, maxAttempts, err);
        return retry(err);
      }
    }
  );

  return provider.waitForTransactionReceipt({ hash });
}
