import * as viem from 'viem';

function parseJson(v: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(v) };
  } catch {
    return { ok: false };
  }
}

/**
 * Brings a recorded or on-chain value to one canonical shape by its ABI parameter, so two values can be compared
 * structurally. Never throws on bad input: an unusable value becomes a marker string that matches nothing.
 */
export function normalize(value: unknown, param: viem.AbiParameter): unknown {
  const t = param.type;
  if (value === undefined || value === null) return null;

  if (/\[\d*\]$/.test(t)) {
    const inner = { ...param, type: t.slice(0, t.lastIndexOf('[')) } as viem.AbiParameter;
    let arr: unknown = value;
    if (typeof value === 'string') {
      const parsed = parseJson(value);
      if (!parsed.ok) return `<unparsed ${value}>`;
      arr = parsed.value;
    }
    if (arr === null || arr === undefined) return [];
    if (!Array.isArray(arr)) return `<unparsed ${String(value)}>`;
    return arr.map((x) => normalize(x, inner));
  }

  if (t === 'tuple') {
    const components = (param as viem.AbiParameter & { components: readonly viem.AbiParameter[] }).components;
    let obj: unknown = value;
    if (typeof value === 'string') {
      const parsed = parseJson(value);
      if (!parsed.ok) return `<unparsed ${value}>`;
      obj = parsed.value;
    }
    if (obj === null || typeof obj !== 'object') return `<unparsed ${String(value)}>`;
    return components.map((c, i) =>
      normalize(Array.isArray(obj) ? obj[i] : (obj as Record<string, unknown>)[c.name || ''], c)
    );
  }

  if (t === 'address') {
    const s = String(value);
    return viem.isAddress(s, { strict: false }) ? viem.getAddress(s) : `<bad address ${s}>`;
  }

  if (/^u?int/.test(t)) {
    try {
      const v =
        typeof value === 'string' && /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(value)
          ? Number(value).toLocaleString('fullwide', { useGrouping: false })
          : (value as string | number | bigint);
      return BigInt(v).toString();
    } catch {
      return `<bad int ${String(value)}>`;
    }
  }

  if (t === 'bool') return value === true || value === 'true';
  if (t.startsWith('bytes')) return String(value).toLowerCase();
  return String(value);
}

/** `JSON.stringify` replacer: a bigint becomes its decimal string. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * The shape a hint outcome's values are kept in, so that rows of one slot compare equal whatever types a hint
 * returned: a bigint becomes its decimal string, a 20-byte hex string is checksummed (EIP-55), any other hex string
 * is lower case, arrays and plain objects are converted element by element; anything else is kept as returned.
 */
export function canonicalValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') {
    if (/^0x[0-9a-f]{40}$/i.test(v)) return viem.getAddress(v);
    return /^0x[0-9a-f]*$/i.test(v) ? v.toLowerCase() : v;
  }
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canonicalValue(x)]));
  return v;
}

/** Deep equality of two already normalized values. Never throws on a bigint: it equals its decimal string. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, bigintReplacer) === JSON.stringify(b, bigintReplacer);
}
