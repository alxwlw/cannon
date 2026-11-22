import * as viem from 'viem';
import { normalize, sameValue } from './normalize';
import { ChainReader } from './read';
import { Check, CheckOutcome, Slot } from './types';

/** Events of the step as recorded in the package: args are stored as strings, so they are compared by shape. */
export type RecordedEvents = Record<string, { args: unknown[] }[]>;

type Param = viem.AbiParameter;
const NORMALIZED_BY_CONTRACT = 'normalized by contract (matches recorded event)';

/** Builds the argument viem wants for a call from a value normalized by its ABI parameter. */
function toCallArg(value: unknown, param: Param): unknown {
  const t = param.type;
  if (/\[\d*\]$/.test(t) && Array.isArray(value)) {
    const inner = { ...param, type: t.slice(0, t.lastIndexOf('[')) } as Param;
    return value.map((x) => toCallArg(x, inner));
  }
  if (t === 'tuple' && Array.isArray(value)) {
    const components = (param as Param & { components: readonly Param[] }).components;
    return Object.fromEntries(components.map((c, i) => [c.name || String(i), toCallArg(value[i], c)]));
  }
  if (/^u?int/.test(t) && typeof value === 'string') return BigInt(value);
  return value;
}

const asList = (getter: viem.AbiFunction, result: unknown): unknown[] =>
  getter.outputs.length === 1 ? [result] : Array.from(result as ArrayLike<unknown>);

/** Arrays of arrays are compared as sets: each inner array is sorted. */
function setLike(x: unknown): unknown {
  return Array.isArray(x) && x.every((y) => Array.isArray(y))
    ? x.map((y: unknown[]) => [...y].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    : x;
}

const firstLine = (s: string) => s.split('\n')[0];
/** The first line of an error: viem's `shortMessage` when it has one. */
export function shortError(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown };
  return firstLine(String(err?.shortMessage || err?.message || e));
}

/** A shape in which a recorded string, a bigint and a normalized chain value for the same quantity are equal. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'string') return /^0x/i.test(v) ? v.toLowerCase() : v;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v ?? null;
}

/**
 * The normalized key arguments of a check: they name the slot, they are never the value written to it. A fields or
 * struct-keyed check has none here: its parts are matched on their own, and its whole actual is a tuple that no
 * single event arg can equal.
 */
function keyArgsOf(chk: Check, setter: viem.AbiFunction, args: unknown[]): unknown[] {
  return 'keyIdx' in chk ? chk.keyIdx.map((i) => normalize(args[i], setter.inputs[i])) : [];
}

/**
 * Whether a recorded event says the contract stored the value the chain holds: all of an event's args equal the
 * value (a multi-value getter), or its last arg does (`ValueSet(key, value)`), unless that arg is one of the
 * step's key args.
 */
function matchesRecordedEvent(actual: unknown, events: RecordedEvents | undefined, keys: unknown[]): boolean {
  if (!events) return false;
  const target = canon(actual);
  const single = Array.isArray(actual) && actual.length === 1 ? canon(actual[0]) : undefined;
  const isKey = (a: unknown) => keys.some((k) => sameValue(canon(k), canon(a)));
  return Object.values(events)
    .flat()
    .some(({ args }) => {
      if (args.length > 1 && sameValue(canon(args), target)) return true;
      const last = args[args.length - 1];
      if (last === undefined || isKey(last)) return false;
      return sameValue(canon(last), target) || sameValue(canon(last), single);
    });
}

async function evaluate(
  chk: Check,
  setter: viem.AbiFunction,
  args: unknown[],
  address: viem.Address,
  reader: ChainReader,
  events: RecordedEvents | undefined
): Promise<CheckOutcome> {
  if (chk.compare === 'fields') {
    const parts: CheckOutcome[] = [];
    for (const f of chk.fields) parts.push(await runCheck(f, setter, args, address, reader, events));
    const drift = parts.some((p) => p.status === 'drift');
    return {
      status: drift ? 'drift' : parts.every((p) => p.status === 'in-sync') ? 'in-sync' : 'error',
      getter: parts.map((p) => p.getter).join('+'),
      expected: parts.map((p) => p.expected),
      actual: parts.map((p) => p.actual),
      detail:
        parts
          .map((p) => p.detail)
          .filter(Boolean)
          .join('; ') || undefined,
    };
  }

  const getter = chk.getter;
  const slotOf = (keyParams: Param[], keyValues: unknown[]): Slot => ({
    address,
    getter: getter.name,
    keys: JSON.stringify(keyParams.map((p, i) => normalize(keyValues[i], p))),
  });

  if (chk.compare === 'structKeyed') {
    const struct = setter.inputs[0] as Param & { components: readonly Param[] };
    const value = normalize(args[0], struct) as unknown[];
    const keyParams = chk.keyFields.map((fi) => struct.components[fi]);
    const keyValues = chk.keyFields.map((fi) => value[fi]);
    const result = await reader.call(
      address,
      getter,
      keyValues.map((v, i) => toCallArg(v, keyParams[i]))
    );
    const actual = normalize(result, getter.outputs[0]);
    return {
      status: sameValue(value, actual) ? 'in-sync' : 'drift',
      getter: getter.name,
      expected: value,
      actual,
      slot: { address, getter: getter.name, keys: JSON.stringify(keyValues) },
    };
  }

  const keyParams = chk.keyIdx.map((i) => setter.inputs[i]);
  const keyNorm = chk.keyIdx.map((i, j) => normalize(args[i], keyParams[j]));
  const slot = slotOf(
    keyParams,
    chk.keyIdx.map((i) => args[i])
  );
  const result = await reader.call(
    address,
    getter,
    keyNorm.map((v, j) => toCallArg(v, keyParams[j]))
  );

  if (chk.compare === 'contains' || chk.compare === 'notContains') {
    const vi = chk.valueIdx[0];
    const expected = normalize(args[vi], setter.inputs[vi]);
    const list = normalize(result, getter.outputs[0]) as unknown[];
    const has = list.some((x) => sameValue(x, expected));
    return {
      status: has === (chk.compare === 'contains') ? 'in-sync' : 'drift',
      getter: getter.name,
      expected,
      actual: list,
      slot,
    };
  }

  if (chk.compare === 'ownerOrNominated') {
    const expected = normalize(args[0], setter.inputs[0]);
    const owner = normalize(result, getter.outputs[0]);
    const nominated = chk.alt ? normalize(await reader.call(address, chk.alt, []), chk.alt.outputs[0]) : null;
    return {
      status: sameValue(owner, expected) || sameValue(nominated, expected) ? 'in-sync' : 'drift',
      getter: 'owner/nominatedOwner',
      expected,
      actual: { owner, nominated },
      slot,
    };
  }

  let expected: unknown;
  let actual: unknown;
  if (chk.compare === 'outputs') {
    expected = chk.valueIdx.map((i) => normalize(args[i], setter.inputs[i]));
    actual = asList(getter, result).map((x, j) => normalize(x, getter.outputs[j]));
  } else if (chk.compare === 'tupleOut') {
    expected = chk.valueIdx.map((i) => normalize(args[i], setter.inputs[i]));
    actual = normalize(result, getter.outputs[0]);
  } else {
    expected = normalize(args[chk.valueIdx[0]], setter.inputs[chk.valueIdx[0]]);
    actual = asList(getter, result).map((x, j) => normalize(x, getter.outputs[j]));
  }
  const ok = sameValue(expected, actual) || sameValue(setLike(expected), setLike(actual));
  return { status: ok ? 'in-sync' : 'drift', getter: getter.name, expected, actual, slot };
}

/**
 * Runs one derived check against the pinned chain state. Never throws: a failed read is an `error` outcome.
 * `expected` and `actual` are normalized values, so a caller can compare them with `sameValue`.
 */
export async function runCheck(
  check: Check,
  setter: viem.AbiFunction,
  args: unknown[],
  address: viem.Address,
  reader: ChainReader,
  events?: RecordedEvents
): Promise<CheckOutcome> {
  let outcome: CheckOutcome;
  try {
    outcome = await evaluate(check, setter, args, address, reader, events);
  } catch (e) {
    const getter =
      'getter' in check ? check.getter.name : check.fields.map((f) => ('getter' in f ? f.getter.name : '')).join('+');
    return { status: 'error', getter, expected: null, actual: null, detail: shortError(e) };
  }
  if (outcome.status === 'drift' && matchesRecordedEvent(outcome.actual, events, keyArgsOf(check, setter, args))) {
    return { ...outcome, status: 'in-sync', detail: NORMALIZED_BY_CONTRACT };
  }
  return outcome;
}
