import path from 'node:path';
import { types } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as viem from 'viem';
import { CheckOutcome, StepResult } from './types';
import { RecordedEvents } from './check';
import { ChainReader } from './read';

export interface HintContext {
  step: string;
  setter: viem.AbiFunction;
  args: unknown[];
  address: viem.Address;
  abi: viem.Abi;
  events: RecordedEvents;
  /** A string is a human-readable signature, parsed with viem.parseAbiItem. */
  read: (address: viem.Address, fn: viem.AbiFunction | string, args: unknown[]) => Promise<unknown>;
}

export interface HintsModule {
  /**
   * Keyed by setter function name (own keys only); `null` means "no opinion", the automatic rule runs. A check gets
   * the call's ABI-decoded `args`: bigint, checksummed address, boolean, tuple object. The `expected` and `actual` it
   * returns are kept in one shape: a bigint becomes its decimal string, a 20-byte hex string is checksummed, any other
   * hex string is lower case, arrays and plain objects element by element. Return a `slot` whose `keys` (a string)
   * identifies exactly one value to link the row with other writes of that value: an earlier drift of the same slot
   * is superseded, and an orphan that wrote the live value explains the drift.
   */
  checks?: Record<string, (ctx: HintContext) => Promise<CheckOutcome | null>>;
  /** Step names, e.g. 'invoke.initializeThing'. */
  skip?: (string | RegExp)[];
  enumerations?: ((ctx: { results: StepResult[]; read: HintContext['read'] }) => Promise<StepResult[]>)[];
}

// tsc compiles this package to CommonJS, which rewrites a literal `import(p)` into `require(p)` and so cannot load
// `.mjs`. Building the call from a string keeps it a real dynamic import in the built CLI on every supported Node.
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function importModule(file: string): Promise<unknown> {
  if (/\.mjs$/i.test(file)) {
    return nativeImport(pathToFileURL(file).href);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(file);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validate(mod: unknown): HintsModule {
  if (!isRecord(mod)) throw new Error('module must export an object');
  const { checks, skip, enumerations } = mod;

  if (checks !== undefined) {
    if (!isRecord(checks)) throw new Error('checks must be an object of functions');
    for (const [name, fn] of Object.entries(checks)) {
      if (typeof fn !== 'function') throw new Error(`checks.${name} is not a function`);
    }
  }
  if (skip !== undefined) {
    if (!Array.isArray(skip) || !skip.every((s) => typeof s === 'string' || types.isRegExp(s))) {
      throw new Error('skip must be an array of strings or RegExps');
    }
  }
  if (enumerations !== undefined) {
    if (!Array.isArray(enumerations) || !enumerations.every((e) => typeof e === 'function')) {
      throw new Error('enumerations must be an array of functions');
    }
  }
  return { checks, skip, enumerations } as HintsModule;
}

export async function loadHints(file?: string): Promise<HintsModule> {
  if (!file) return {};
  const resolved = path.resolve(process.cwd(), file);
  try {
    const mod = (await importModule(resolved)) as { default?: unknown } | null;
    // CJS interop and ESM both put the payload on `default`; a namespace without one is the payload itself.
    const payload = isRecord(mod) && 'default' in mod ? mod.default : mod;
    return validate(payload);
  } catch (e) {
    throw new Error(`--hints ${resolved}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function isSkipped(hints: HintsModule, step: string): boolean {
  return (hints.skip ?? []).some((s) => (typeof s === 'string' ? s === step : new RegExp(s.source, s.flags).test(step)));
}

export function makeRead(reader: ChainReader): HintContext['read'] {
  return async (address, fn, args) => {
    if (typeof fn !== 'string') return reader.call(address, fn, args);
    const sig = fn.trim();
    // the signature is user text, so the compile-time signature check of parseAbiItem cannot apply
    const parse: (text: string) => viem.AbiItem = viem.parseAbiItem as never;
    const item = parse(/^(function|event|error|constructor|fallback|receive)\b/.test(sig) ? sig : `function ${sig}`);
    if (item.type !== 'function') throw new Error(`hint read: "${fn}" is not a function signature`);
    return reader.call(address, item, args);
  };
}
