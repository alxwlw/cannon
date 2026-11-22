import * as viem from 'viem';
import { normalize, sameValue } from './normalize';

const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummed = '0x52908400098527886E0F7030069857D2E4169EE7';

const tupleParam: viem.AbiParameter = {
  type: 'tuple',
  name: 't',
  components: [
    { type: 'uint256', name: 'amount' },
    { type: 'address', name: 'who' },
    { type: 'bool', name: 'on' },
  ],
};

describe('normalize', () => {
  it('turns bigint, number and decimal string ints into the same decimal string', () => {
    expect(normalize(1n, { type: 'uint256' })).toBe('1');
    expect(normalize(2, { type: 'uint8' })).toBe('2');
    expect(normalize('300', { type: 'int256' })).toBe('300');
  });

  it('expands exponent notation of ints', () => {
    expect(normalize('1e3', { type: 'uint256' })).toBe('1000');
  });

  it('parses a hex string containing e exactly, not as exponent notation', () => {
    const hex = '0xfffffffffffffffffffffffffffffffe';
    expect(normalize(hex, { type: 'uint256' })).toBe(BigInt(hex).toString());
  });

  it('returns a marker for an unparseable int instead of throwing', () => {
    expect(normalize('abc', { type: 'uint256' })).toBe('<bad int abc>');
  });

  it('checksums a valid address', () => {
    expect(normalize(lower, { type: 'address' })).toBe(checksummed);
    expect(normalize(checksummed, { type: 'address' })).toBe(checksummed);
  });

  it('returns a marker for an invalid address instead of throwing', () => {
    expect(normalize('0x1234', { type: 'address' })).toBe('<bad address 0x1234>');
  });

  it('lower-cases bytes', () => {
    expect(normalize('0xABCD', { type: 'bytes' })).toBe('0xabcd');
    expect(normalize('0xABCD', { type: 'bytes32' })).toBe('0xabcd');
  });

  it('reads bool from true and "true" only', () => {
    expect(normalize(true, { type: 'bool' })).toBe(true);
    expect(normalize('true', { type: 'bool' })).toBe(true);
    expect(normalize('false', { type: 'bool' })).toBe(false);
    expect(normalize(false, { type: 'bool' })).toBe(false);
  });

  it('maps null and undefined to null', () => {
    expect(normalize(null, { type: 'uint256' })).toBeNull();
    expect(normalize(undefined, { type: 'address' })).toBeNull();
  });

  it('stringifies other types', () => {
    expect(normalize('hello', { type: 'string' })).toBe('hello');
  });

  it('normalizes a tuple given as an object and as an array to the same array', () => {
    const asObject = { amount: 5n, who: lower, on: 'true' };
    const asArray = ['5', checksummed, true];
    const expected = ['5', checksummed, true];
    expect(normalize(asObject, tupleParam)).toEqual(expected);
    expect(normalize(asArray, tupleParam)).toEqual(expected);
  });

  it('parses a JSON string tuple', () => {
    expect(normalize(JSON.stringify({ amount: '7', who: lower, on: false }), tupleParam)).toEqual(['7', checksummed, false]);
  });

  it('returns a marker for an unparseable JSON tuple and for a non-object tuple', () => {
    expect(normalize('{nope', tupleParam)).toBe('<unparsed {nope>');
    expect(normalize(12, tupleParam)).toBe('<unparsed 12>');
  });

  it('normalizes arrays element-wise, from an array or a JSON string', () => {
    const p: viem.AbiParameter = { type: 'address[]' };
    expect(normalize([lower], p)).toEqual([checksummed]);
    expect(normalize(JSON.stringify([lower]), p)).toEqual([checksummed]);
  });

  it('returns a marker for an unparseable JSON array', () => {
    expect(normalize('[oops', { type: 'uint256[]' })).toBe('<unparsed [oops>');
  });

  it('normalizes fixed-size arrays and arrays of tuples', () => {
    expect(normalize([1, 2n], { type: 'uint256[2]' })).toEqual(['1', '2']);
    expect(normalize([{ amount: 1, who: lower, on: true }], { ...tupleParam, type: 'tuple[]' })).toEqual([
      ['1', checksummed, true],
    ]);
  });
});

describe('sameValue', () => {
  it('is true for address arrays that differ only in case after normalization', () => {
    const p: viem.AbiParameter = { type: 'address[]' };
    expect(sameValue(normalize([checksummed], p), normalize([lower], p))).toBe(true);
  });

  it('is false for different values', () => {
    expect(sameValue(normalize(1n, { type: 'uint256' }), normalize(2n, { type: 'uint256' }))).toBe(false);
    expect(sameValue(['1'], ['1', '2'])).toBe(false);
  });
});
