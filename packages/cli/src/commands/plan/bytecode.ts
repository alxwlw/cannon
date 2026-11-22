import * as viem from 'viem';

export type CodeComparison = { status: 'in-sync' | 'drift' | 'unchecked'; detail?: string };
export type ByteRange = { start: number; length: number };

// `__$<34 hex>$__` is 40 chars = 20 bytes: a library link reference in unlinked bytecode
const LINK_PLACEHOLDER = /__\$[0-9a-f]{34}\$__/g;
const IMMUTABLE_TOLERANCE_BYTES = 32;

const normalize = (hex: string) => hex.replace(/^0x/i, '').toLowerCase();

// Solidity appends CBOR metadata whose byte length sits in the last 2 bytes.
function stripMeta(h: string): string {
  if (h.length < 4) return h;
  const metaChars = parseInt(h.slice(-4), 16) * 2;
  return metaChars > 0 && metaChars + 4 <= h.length ? h.slice(0, h.length - metaChars - 4) : h;
}

function placeholderRanges(h: string): [number, number][] {
  return [...h.matchAll(LINK_PLACEHOLDER)].map((m) => [m.index! / 2, m.index! / 2 + 20]);
}

// Half-open byte ranges [start, end) where `a` and `b` differ, skipping masked bytes.
function diffRanges(a: string, b: string, masked: [number, number][]): [number, number][] {
  const skip = new Set<number>();
  for (const [s, e] of masked) for (let i = s; i < e; i++) skip.add(i);

  const ranges: [number, number][] = [];
  let start = -1;
  const bytes = a.length / 2;
  for (let i = 0; i < bytes; i++) {
    const differs = !skip.has(i) && a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2);
    if (differs && start < 0) start = i;
    if (!differs && start >= 0) {
      ranges.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, bytes]);
  return ranges;
}

export function compareCode(
  onchain: viem.Hex | undefined,
  expected: string | undefined,
  immutableRanges?: ByteRange[]
): CodeComparison {
  // checked first: a missing artifact must not hide a contract that has no code
  if (!onchain || normalize(onchain) === '') return { status: 'drift', detail: 'no code at address' };
  if (!expected || normalize(expected) === '') return { status: 'unchecked', detail: 'no artifact' };

  const exp = normalize(expected);
  const links = placeholderRanges(exp);
  const a = stripMeta(normalize(onchain));
  const b = stripMeta(exp);
  if (a.length !== b.length) return { status: 'drift', detail: `length ${a.length / 2} vs expected ${b.length / 2} bytes` };

  const masked = [...links];
  if (immutableRanges) masked.push(...immutableRanges.map((r): [number, number] => [r.start, r.start + r.length]));

  const ranges = diffRanges(a, b, masked);
  if (ranges.length === 0) return { status: 'in-sync' };

  if (immutableRanges) {
    return {
      status: 'drift',
      detail: `${ranges.length} differing range(s) outside immutables, first at byte ${ranges[0][0]}`,
    };
  }

  const largest = Math.max(...ranges.map(([s, e]) => e - s));
  if (largest <= IMMUTABLE_TOLERANCE_BYTES) {
    return { status: 'in-sync', detail: `equal modulo ${ranges.length} immutable slot(s)` };
  }
  return { status: 'drift', detail: `${ranges.length} differing range(s), largest ${largest} bytes` };
}
