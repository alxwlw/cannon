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

// everything viem fills in by default except the nonce, which is assigned at send time so that a
// local account's nonce manager is consulted right before signing (see resetSignerNonce)
const PREPARE_PARAMETERS: viem.PrepareTransactionRequestParameterType[] = ['chainId', 'fees', 'gas', 'type'];

// cannonfile `overrides.gasLimit` is a decimal string; viem expects `gas` as a bigint
export function parseGasLimit(gasLimit: string | undefined): bigint | undefined {
  return gasLimit ? BigInt(gasLimit) : undefined;
}

// Resets the signer's viem nonce manager (when it has one) so the next send re-reads the pending
// nonce from the chain without ever regressing below a nonce it already handed out. Live private-key
// signers created by the CLI carry a manager; JSON-RPC backed signers (anvil impersonation, Frame)
// do not — the node assigns their nonces on every send. Returns whether a reset happened.
async function resetSignerNonce(signer: CannonSigner): Promise<boolean> {
  const account = signer.wallet.account;
  if (account?.type !== 'local' || !account.nonceManager) return false;

  // the manager is keyed by (address, chainId); resolve the chain id the way viem does at consume time
  const chainId = signer.wallet.chain?.id ?? (await signer.wallet.getChainId());
  account.nonceManager.reset({ address: account.address, chainId });
  return true;
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
// the nonce on the provider, hand the request to the signer's wallet (which assigns the nonce), and
// retry any failure with backoff. There is no reliable error shape for nonce problems across RPC
// providers, so every failure is treated as a possibly broken nonce: the signer's nonce manager is
// reset before the retry. Deterministic failures (reverts) fail identically on each attempt and surface
// the last error. The one exception is an explicit user rejection (EIP-1193 code 4001), which is never
// retried. Resolves with the receipt once the transaction is mined.
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

        try {
          const didReset = await resetSignerNonce(signer);
          debug(`broadcast attempt ${attempt}/${maxAttempts} failed${didReset ? ' (nonce manager reset)' : ''}:`, err);
        } catch (resetErr) {
          // a failed reset must not mask the broadcast error; the retried send will report it
          debug('could not reset nonce manager before retry:', resetErr);
        }

        if (attempt < maxAttempts) ctx.onRetry?.(attempt, maxAttempts, err);
        return retry(err);
      }
    }
  );

  return provider.waitForTransactionReceipt({ hash });
}
