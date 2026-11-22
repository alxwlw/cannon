import * as viem from 'viem';
import { runCheck } from './check';
import { deriveCheck } from './derive';
import { ChainReader } from './read';

const ADDR = '0x00000000000000000000000000000000000000aa' as viem.Address;
const OWNER = '0x1111111111111111111111111111111111111111' as viem.Address;
const OTHER = '0x2222222222222222222222222222222222222222' as viem.Address;

const abi = viem.parseAbi([
  'function setValue(uint256 v)',
  'function getValue() view returns (uint256)',
  'function setDelay(uint256 d)',
  'function getDelay() view returns (uint256)',
  'function setLimit(uint128 id, uint256 v)',
  'function getLimit(uint128 id) view returns (uint256)',
  'function addToAllowlist(address a)',
  'function removeFromAllowlist(address a)',
  'function getAllowlist() view returns (address[])',
  'function nominateNewOwner(address n)',
  'function owner() view returns (address)',
  'function nominatedOwner() view returns (address)',
  'function setPair(uint256 a, uint256 b)',
  'function getPair() view returns (uint256 a, uint256 b)',
  'function setPairs(uint256[] a, uint256[] b)',
  'function getPairs() view returns (uint256[] a, uint256[] b)',
  'struct Cfg { address token; uint256 amount; }',
  'function configureThing(Cfg cfg)',
  'function getThingConfiguration(address token) view returns (Cfg)',
  'function createThing(uint256 a, uint256 b)',
  'function getThingA() view returns (uint256)',
  'function getThingB() view returns (uint256)',
]);
const fn = (name: string) => abi.find((f) => f.type === 'function' && f.name === name) as viem.AbiFunction;
const derive = (name: string) => {
  const c = deriveCheck(fn(name), abi);
  if (!c) throw new Error('no check derived for ' + name);
  return c;
};

const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** In-memory reader: `address|fn|args` -> value, anything else throws like a reverted call. */
function fakeReader(values: Record<string, unknown>): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    blockNumber: 10n,
    async call(address, f, args) {
      const key = `${address}|${f.name}|${show(args)}`;
      calls.push(key);
      if (!(key in values))
        throw Object.assign(new Error('call reverted\nsecond line'), { shortMessage: 'reverted: no value' });
      return values[key];
    },
    async getCode() {
      return undefined;
    },
    async getTransaction() {
      return { to: null, input: '0x' };
    },
  };
}
const k = (name: string, args: unknown[] = []) => `${ADDR}|${name}|${show(args)}`;

describe('runCheck', () => {
  it('equal: in-sync with a slot', async () => {
    const out = await runCheck(derive('setValue'), fn('setValue'), [5n], ADDR, fakeReader({ [k('getValue')]: 5n }));
    expect(out).toMatchObject({ status: 'in-sync', getter: 'getValue', expected: ['5'], actual: ['5'] });
  });

  it('equal: drift reports normalized expected and actual', async () => {
    const out = await runCheck(derive('setValue'), fn('setValue'), ['7'], ADDR, fakeReader({ [k('getValue')]: 9n }));
    expect(out).toMatchObject({ status: 'drift', expected: ['7'], actual: ['9'] });
  });

  it('slot carries the getter and the normalized key arguments', async () => {
    const out = await runCheck(
      derive('setLimit'),
      fn('setLimit'),
      [7n, 5n],
      ADDR,
      fakeReader({ [k('getLimit', [7n])]: 5n })
    );
    expect(out.slot).toEqual({ address: ADDR, getter: 'getLimit', keys: '["7"]' });
    expect(out.status).toBe('in-sync');
  });

  it('contains: in-sync when the chain list is checksummed and the arg is lower-case; expected is the member', async () => {
    const chain = [viem.getAddress(OWNER), viem.getAddress(OTHER)];
    const out = await runCheck(
      derive('addToAllowlist'),
      fn('addToAllowlist'),
      [OTHER.toLowerCase()],
      ADDR,
      fakeReader({ [k('getAllowlist')]: chain })
    );
    expect(out.status).toBe('in-sync');
    expect(out.expected).toBe(viem.getAddress(OTHER));
    expect(out.actual).toEqual(chain);
  });

  it('notContains: drift while the member is still listed', async () => {
    const out = await runCheck(
      derive('removeFromAllowlist'),
      fn('removeFromAllowlist'),
      [OWNER],
      ADDR,
      fakeReader({ [k('getAllowlist')]: [OWNER] })
    );
    expect(out).toMatchObject({ status: 'drift', expected: viem.getAddress(OWNER), actual: [viem.getAddress(OWNER)] });
  });

  it('notContains: in-sync once the member is gone', async () => {
    const out = await runCheck(
      derive('removeFromAllowlist'),
      fn('removeFromAllowlist'),
      [OWNER],
      ADDR,
      fakeReader({ [k('getAllowlist')]: [OTHER] })
    );
    expect(out.status).toBe('in-sync');
  });

  it('structKeyed: struct argument given as an object', async () => {
    const out = await runCheck(
      derive('configureThing'),
      fn('configureThing'),
      [{ token: OWNER.toLowerCase(), amount: '42' }],
      ADDR,
      fakeReader({ [k('getThingConfiguration', [viem.getAddress(OWNER)])]: { token: viem.getAddress(OWNER), amount: 42n } })
    );
    expect(out).toMatchObject({ status: 'in-sync', getter: 'getThingConfiguration' });
    expect(out.slot).toEqual({ address: ADDR, getter: 'getThingConfiguration', keys: show([viem.getAddress(OWNER)]) });
  });

  it('structKeyed: struct argument given as an array, drift on a wrong amount', async () => {
    const out = await runCheck(
      derive('configureThing'),
      fn('configureThing'),
      [[OWNER, '42']],
      ADDR,
      fakeReader({ [k('getThingConfiguration', [viem.getAddress(OWNER)])]: [viem.getAddress(OWNER), 41n] })
    );
    expect(out.status).toBe('drift');
  });

  it('ownerOrNominated: in-sync when only nominatedOwner matches', async () => {
    const out = await runCheck(
      derive('nominateNewOwner'),
      fn('nominateNewOwner'),
      [OTHER],
      ADDR,
      fakeReader({ [k('owner')]: OWNER, [k('nominatedOwner')]: OTHER })
    );
    expect(out).toMatchObject({ status: 'in-sync', getter: 'owner/nominatedOwner' });
  });

  it('ownerOrNominated: drift when neither matches', async () => {
    const third = '0x3333333333333333333333333333333333333333';
    const out = await runCheck(
      derive('nominateNewOwner'),
      fn('nominateNewOwner'),
      [third],
      ADDR,
      fakeReader({ [k('owner')]: OWNER, [k('nominatedOwner')]: OTHER })
    );
    expect(out.status).toBe('drift');
  });

  it('outputs on a multi-output getter compares position by position', async () => {
    const reader = fakeReader({ [k('getPair')]: [1n, 2n] });
    expect((await runCheck(derive('setPair'), fn('setPair'), [1n, 2n], ADDR, reader)).status).toBe('in-sync');
    expect((await runCheck(derive('setPair'), fn('setPair'), [1n, 3n], ADDR, reader)).status).toBe('drift');
  });

  it('outputs on arrays of arrays compares each array as a set', async () => {
    const out = await runCheck(
      derive('setPairs'),
      fn('setPairs'),
      [[1n, 2n], [3n]],
      ADDR,
      fakeReader({ [k('getPairs')]: [[2n, 1n], [3n]] })
    );
    expect(out.status).toBe('in-sync');
  });

  it('fields: in-sync when every part is, drift when one part drifts, no slot', async () => {
    const chk = derive('createThing');
    expect(chk.compare).toBe('fields');
    const ok = await runCheck(
      chk,
      fn('createThing'),
      [1n, 2n],
      ADDR,
      fakeReader({ [k('getThingA')]: 1n, [k('getThingB')]: 2n })
    );
    expect(ok.status).toBe('in-sync');
    expect(ok.slot).toBeUndefined();
    expect(ok.getter).toBe('getThingA+getThingB');
    const bad = await runCheck(
      chk,
      fn('createThing'),
      [1n, 2n],
      ADDR,
      fakeReader({ [k('getThingA')]: 1n, [k('getThingB')]: 3n })
    );
    expect(bad).toMatchObject({ status: 'drift', expected: [['1'], ['2']], actual: [['1'], ['3']] });
  });

  it('fields: a part that errors with no drift makes the whole check an error', async () => {
    const out = await runCheck(
      derive('createThing'),
      fn('createThing'),
      [1n, 2n],
      ADDR,
      fakeReader({ [k('getThingA')]: 1n })
    );
    expect(out.status).toBe('error');
  });

  it('a throwing reader gives an error with the first line of the short message', async () => {
    const out = await runCheck(derive('setValue'), fn('setValue'), [1n], ADDR, fakeReader({}));
    expect(out).toMatchObject({ status: 'error', getter: 'getValue', detail: 'reverted: no value' });
  });

  it('an error without shortMessage uses the first line of the message', async () => {
    const reader = fakeReader({});
    reader.call = async () => {
      throw new Error('boom\nstack-ish');
    };
    const out = await runCheck(derive('setValue'), fn('setValue'), [1n], ADDR, reader);
    expect(out).toMatchObject({ status: 'error', detail: 'boom' });
  });

  describe('normalization by contract', () => {
    const run = (events?: Record<string, { args: unknown[] }[]>, chain = 1n, recorded: unknown = 0) =>
      runCheck(derive('setDelay'), fn('setDelay'), [recorded], ADDR, fakeReader({ [k('getDelay')]: chain }), events);

    it('recorded 0, chain 1, event carries 1n: in-sync', async () => {
      expect(await run({ DelaySet: [{ args: [1n] }] })).toMatchObject({
        status: 'in-sync',
        detail: 'normalized by contract (matches recorded event)',
      });
    });

    it('event args recorded as strings match too', async () => {
      expect((await run({ DelaySet: [{ args: ['1'] }] })).status).toBe('in-sync');
    });

    it('stays drift when no event argument matches the chain value', async () => {
      expect((await run({ DelaySet: [{ args: [2n] }] })).status).toBe('drift');
    });

    it('stays drift without events', async () => {
      expect((await run(undefined)).status).toBe('drift');
      expect((await run({})).status).toBe('drift');
    });

    it('an in-sync result is not touched by events', async () => {
      const out = await run({ DelaySet: [{ args: [1n] }] }, 0n);
      expect(out.status).toBe('in-sync');
      expect(out.detail).toBeUndefined();
    });

    it('a whole args tuple may match the actual value', async () => {
      const chk = derive('setPair');
      const out = await runCheck(chk, fn('setPair'), [1n, 2n], ADDR, fakeReader({ [k('getPair')]: [1n, 9n] }), {
        PairSet: [{ args: ['1', '9'] }],
      });
      expect(out.status).toBe('in-sync');
    });
  });
});
