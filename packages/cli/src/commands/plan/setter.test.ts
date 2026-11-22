import * as viem from 'viem';
import { kindOf } from './kind';
import { ChainReader } from './read';
import { checkSetter, decodeArgs, SetterCall } from './setter';
import { CheckOutcome } from './types';

const ADDR = viem.getAddress('0x00000000000000000000000000000000000ac0de');
const MEMBER = viem.getAddress('0x00000000000000000000000000000000000a11ce');

const abi = viem.parseAbi([
  'function toString(uint256 x)',
  'function setPair((uint256 a, bool b) p)',
  'function setMember(address m, bool on)',
]);
const OUTCOME: CheckOutcome = { status: 'in-sync', getter: 'g', expected: 1, actual: 1 };
const fn = (name: string) => abi.find((f) => f.type === 'function' && f.name === name) as viem.AbiFunction;

const noReads: ChainReader = {
  blockNumber: 1n,
  call: () => Promise.reject(new Error('no reads in this test')),
  getCode: () => Promise.reject(new Error('no reads in this test')),
  getTransaction: () => Promise.reject(new Error('no reads in this test')),
};

const call = (over: Partial<SetterCall>): SetterCall => ({
  step: 'invoke.x',
  setter: fn('toString'),
  abi,
  address: ADDR,
  args: [1n],
  events: {},
  reader: noReads,
  hints: {},
  ...over,
});

describe('decodeArgs', () => {
  it('gives rendered args the shape the contract decoded: bigint, checksummed address, boolean, tuple object', () => {
    expect(decodeArgs(fn('setMember'), [MEMBER.toLowerCase(), true])).toEqual([MEMBER, true]);
    expect(decodeArgs(fn('setPair'), [['3', false]])).toEqual([{ a: 3n, b: false }]);
  });

  it('throws on args viem cannot encode', () => {
    expect(() => decodeArgs(fn('toString'), ['three'])).toThrow('Cannot convert three to a BigInt');
  });
});

describe('checkSetter', () => {
  it('never takes a hint from Object.prototype: a setter named toString with checks {} has no hint', async () => {
    expect(await checkSetter(call({ hints: { checks: {} } }))).toEqual({
      status: 'unchecked',
      detail: 'no derivable getter',
    });
  });

  it('an own hint of that name is used', async () => {
    const verdict = await checkSetter(
      call({ hints: { checks: { toString: async (): Promise<CheckOutcome> => ({ ...OUTCOME }) } } })
    );
    expect(verdict).toEqual({
      status: 'checked',
      rule: 'hint:toString',
      outcome: OUTCOME,
    });
  });
});

describe('kindOf', () => {
  it('maps legacy action names and passes the rest through, prototype names included', () => {
    expect(['contract.a', 'provision.b', 'import.c', 'invoke.d', 'toString.e', 'constructor.f'].map(kindOf)).toEqual([
      'deploy',
      'clone',
      'pull',
      'invoke',
      'toString',
      'constructor',
    ]);
  });
});
