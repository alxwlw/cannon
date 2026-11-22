import * as viem from 'viem';
import { compareCode } from './bytecode';

const byte = (b: number, n = 1) => b.toString(16).padStart(2, '0').repeat(n);
// CBOR-style tail: `metaLen` bytes of metadata followed by its 2-byte length
const meta = (fill: number, metaLen = 4) => byte(fill, metaLen) + metaLen.toString(16).padStart(4, '0');
const hex = (body: string, tail: string) => `0x${body}${tail}` as viem.Hex;
const PLACEHOLDER = `__$${'ab'.repeat(17)}$__`; // 40 chars = 20 bytes

const BODY = byte(0x60, 100);
const withRange = (body: string, startByte: number, len: number, fill: number) =>
  body.slice(0, startByte * 2) + byte(fill, len) + body.slice((startByte + len) * 2);

describe('compareCode', () => {
  it('is in-sync when only the metadata tails differ', () => {
    const r = compareCode(hex(BODY, meta(0x11)), hex(BODY, meta(0x22, 6)));
    expect(r).toEqual({ status: 'in-sync' });
  });

  it('normalizes case and the 0x prefix', () => {
    const r = compareCode(`0x${(BODY + meta(0xab)).toUpperCase()}` as viem.Hex, BODY + meta(0xab));
    expect(r).toEqual({ status: 'in-sync' });
  });

  it('tolerates one 32-byte differing range as immutables and says so', () => {
    const r = compareCode(hex(withRange(BODY, 10, 32, 0xff), meta(0x11)), hex(BODY, meta(0x11)));
    expect(r.status).toBe('in-sync');
    expect(r.detail).toMatch(/1 immutable/);
  });

  it('reports the number of tolerated ranges', () => {
    const two = withRange(withRange(BODY, 10, 4, 0xff), 50, 4, 0xee);
    const r = compareCode(hex(two, meta(0x11)), hex(BODY, meta(0x11)));
    expect(r.status).toBe('in-sync');
    expect(r.detail).toMatch(/2 immutable/);
  });

  it('is in-sync with no tolerance detail when immutableRanges cover the difference', () => {
    const r = compareCode(hex(withRange(BODY, 10, 32, 0xff), meta(0x11)), hex(BODY, meta(0x11)), [
      { start: 10, length: 32 },
    ]);
    expect(r).toEqual({ status: 'in-sync' });
  });

  it('is drift for a 33-byte differing range', () => {
    const r = compareCode(hex(withRange(BODY, 10, 33, 0xff), meta(0x11)), hex(BODY, meta(0x11)));
    expect(r.status).toBe('drift');
    expect(r.detail).toMatch(/largest 33 bytes/);
  });

  it('is drift for a 33-byte range even when immutableRanges cover its first 32 bytes', () => {
    const r = compareCode(hex(withRange(BODY, 10, 33, 0xff), meta(0x11)), hex(BODY, meta(0x11)), [
      { start: 10, length: 32 },
    ]);
    expect(r.status).toBe('drift');
  });

  it('is drift for a small difference outside the given immutableRanges (no tolerance heuristic)', () => {
    const r = compareCode(hex(withRange(withRange(BODY, 10, 32, 0xff), 60, 1, 0xee), meta(0x11)), hex(BODY, meta(0x11)), [
      { start: 10, length: 32 },
    ]);
    expect(r.status).toBe('drift');
    expect(r.detail).toMatch(/1 differing range/);
  });

  it('is drift on a length mismatch', () => {
    const r = compareCode(hex(BODY + byte(0x60, 2), meta(0x11)), hex(BODY, meta(0x11)));
    expect(r.status).toBe('drift');
    expect(r.detail).toMatch(/102.*100/);
  });

  it.each([undefined, '0x', '' as viem.Hex])('is drift with "no code at address" for onchain %p', (onchain) => {
    expect(compareCode(onchain as viem.Hex | undefined, hex(BODY, meta(0x11)))).toEqual({
      status: 'drift',
      detail: 'no code at address',
    });
  });

  it('is unchecked with "no artifact" when expected is missing', () => {
    expect(compareCode(hex(BODY, meta(0x11)), undefined)).toEqual({ status: 'unchecked', detail: 'no artifact' });
    expect(compareCode(hex(BODY, meta(0x11)), '')).toEqual({ status: 'unchecked', detail: 'no artifact' });
  });

  it('checks empty onchain code before the missing artifact', () => {
    expect(compareCode('0x', undefined)).toEqual({ status: 'drift', detail: 'no code at address' });
    expect(compareCode(undefined, undefined)).toEqual({ status: 'drift', detail: 'no code at address' });
  });

  describe('library link placeholders', () => {
    const expectedWithLink = (after: string) => BODY.slice(0, 20) + PLACEHOLDER + after + BODY.slice(20 + 40 + after.length);
    const linkedOnchain = (after: string) => BODY.slice(0, 20) + byte(0xcd, 20) + after + BODY.slice(20 + 40 + after.length);

    it('masks the placeholder when immutableRanges are given', () => {
      const r = compareCode(hex(linkedOnchain(''), meta(0x11)), hex(expectedWithLink(''), meta(0x11)), []);
      expect(r).toEqual({ status: 'in-sync' });
    });

    it('still flags a difference elsewhere when immutableRanges are given alongside a placeholder', () => {
      const bad = linkedOnchain('').slice(0, 120) + byte(0xee) + linkedOnchain('').slice(122);
      const r = compareCode(hex(bad, meta(0x11)), hex(expectedWithLink(''), meta(0x11)), []);
      expect(r.status).toBe('drift');
    });

    it('does not merge the link slot into an adjacent immutable range', () => {
      // 20-byte link directly followed by a 32-byte immutable: 52 contiguous bytes differ,
      // yet each part is legitimate
      const imm = byte(0xff, 32);
      const onchain = linkedOnchain(imm);
      const expected = expectedWithLink(byte(0x00, 32));
      const r = compareCode(hex(onchain, meta(0x11)), hex(expected, meta(0x11)));
      expect(r.status).toBe('in-sync');
      expect(r.detail).toMatch(/1 immutable/);
    });

    it('matches uppercase placeholder hex', () => {
      const r = compareCode(
        hex(linkedOnchain(''), meta(0x11)),
        hex(expectedWithLink('').replace(PLACEHOLDER, PLACEHOLDER.toUpperCase()), meta(0x11)),
        []
      );
      expect(r).toEqual({ status: 'in-sync' });
    });
  });
});
