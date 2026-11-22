import * as viem from 'viem';
import { RecordedEvents, runCheck, shortError } from './check';
import { deriveCheck } from './derive';
import { HintsModule, makeRead } from './hints';
import { ChainReader } from './read';
import { CheckOutcome, StepResult } from './types';

export interface SetterCall {
  step: string;
  setter: viem.AbiFunction;
  abi: viem.Abi;
  address: viem.Address;
  /** The arguments as the contract decoded them: bigint, checksummed address, boolean (see `decodeArgs`). */
  args: readonly unknown[];
  events: RecordedEvents;
  reader: ChainReader;
  hints: HintsModule;
}

export type SetterVerdict =
  | { status: 'checked'; rule: string; outcome: CheckOutcome }
  | { status: 'unchecked'; detail: string }
  | { status: 'error'; detail: string };

/**
 * The arguments of a declared step as its contract received them: `build()` encodes the rendered args with
 * `encodeFunctionData`, so this does the same and decodes the call data back. A declared step and an orphan (whose
 * args are decoded from its transaction) then hand a hint the same shape. Throws when viem cannot encode them.
 */
export function decodeArgs(setter: viem.AbiFunction, args: readonly unknown[]): readonly unknown[] {
  const abi: viem.Abi = [setter];
  const data = viem.encodeFunctionData({ abi, functionName: setter.name, args: [...args] });
  return viem.decodeFunctionData({ abi, data }).args ?? [];
}

/**
 * Checks one setter call, for a declared step and an orphan alike. Precedence: a hint for the setter (a `null`
 * outcome falls through), then the getter derived from the ABI, else nothing to compare.
 */
export async function checkSetter(c: SetterCall): Promise<SetterVerdict> {
  const name = c.setter.name;
  // an own key only: a setter named `toString` must not find Object.prototype.toString
  const hint = c.hints.checks && Object.prototype.hasOwnProperty.call(c.hints.checks, name) ? c.hints.checks[name] : null;
  if (hint) {
    let outcome: CheckOutcome | null;
    try {
      outcome = await hint({
        step: c.step,
        setter: c.setter,
        args: [...c.args],
        address: c.address,
        abi: c.abi,
        events: c.events,
        read: makeRead(c.reader),
      });
    } catch (e) {
      return { status: 'error', detail: `hint ${name}: ${shortError(e)}` };
    }
    if (outcome) return { status: 'checked', rule: `hint:${name}`, outcome };
  }
  const check = deriveCheck(c.setter, c.abi);
  if (!check) return { status: 'unchecked', detail: 'no derivable getter' };
  return {
    status: 'checked',
    rule: check.rule,
    outcome: await runCheck(check, c.setter, [...c.args], c.address, c.reader, c.events),
  };
}

/** The report fields of a checked verdict: the check, and the slot and detail when the outcome has them. */
export function checkFields(
  v: Extract<SetterVerdict, { status: 'checked' }>
): Pick<StepResult, 'check' | 'slot' | 'detail'> {
  const { outcome } = v;
  return {
    check: { rule: v.rule, getter: outcome.getter, expected: outcome.expected, actual: outcome.actual },
    ...(outcome.slot ? { slot: outcome.slot } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}
