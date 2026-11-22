import * as viem from 'viem';
import { deriveCheck } from './derive';
import { Check } from './types';

const abi = (...sigs: string[]) => viem.parseAbi(sigs);
const setterOf = (a: viem.Abi, name: string) => a.find((f) => f.type === 'function' && f.name === name) as viem.AbiFunction;
const derive = (name: string, a: viem.Abi) => deriveCheck(setterOf(a, name), a);

// narrowing helper for the keyIdx/valueIdx variants
const plain = (c: Check | null) => {
  if (!c || !('keyIdx' in c)) throw new Error('expected a keyed check, got ' + JSON.stringify(c?.rule));
  return c;
};

describe('deriveCheck builtins', () => {
  it('upgradeTo -> getImplementation()', () => {
    const a = abi('function upgradeTo(address impl)', 'function getImplementation() view returns (address)');
    const c = plain(derive('upgradeTo', a));
    expect(c).toMatchObject({ rule: 'builtin:upgradeTo', compare: 'outputs', keyIdx: [], valueIdx: [0] });
    expect(c.getter.name).toBe('getImplementation');
  });

  it('nominateNewOwner -> owner() with nominatedOwner() as alt', () => {
    const a = abi(
      'function nominateNewOwner(address o)',
      'function owner() view returns (address)',
      'function nominatedOwner() view returns (address)'
    );
    const c = derive('nominateNewOwner', a);
    expect(c).toMatchObject({ rule: 'builtin:nominateNewOwner', compare: 'ownerOrNominated', keyIdx: [], valueIdx: [0] });
    expect((c as Extract<Check, { compare: 'ownerOrNominated' }>).getter.name).toBe('owner');
    expect((c as Extract<Check, { compare: 'ownerOrNominated' }>).alt?.name).toBe('nominatedOwner');
  });

  it('nominateNewOwner without nominatedOwner has no alt', () => {
    const a = abi('function nominateNewOwner(address o)', 'function owner() view returns (address)');
    expect((derive('nominateNewOwner', a) as { alt?: unknown }).alt).toBeUndefined();
  });

  it('a builtin getter that takes arguments is not used', () => {
    const a = abi('function upgradeTo(address impl)', 'function getImplementation(uint256 x) view returns (address)');
    expect(derive('upgradeTo', a)).toBeNull();
  });
});

describe('deriveCheck contains family', () => {
  it('addTo<X> -> contains', () => {
    const a = abi('function addToAllowlist(address a)', 'function getAllowlist() view returns (address[])');
    const c = plain(derive('addToAllowlist', a));
    expect(c).toMatchObject({ rule: 'auto:contains', compare: 'contains', keyIdx: [], valueIdx: [0] });
    expect(c.getter.name).toBe('getAllowlist');
  });

  it('remove<X> -> notContains, with a key', () => {
    const a = abi('function removeMember(uint128 id, address m)', 'function getMember(uint128 id) view returns (address[])');
    const c = plain(derive('removeMember', a));
    expect(c).toMatchObject({ rule: 'auto:notContains', compare: 'notContains', keyIdx: [0], valueIdx: [1] });
  });

  it('a contains setter whose getter does not return an array of the value type derives nothing', () => {
    const a = abi('function addToAllowlist(address a)', 'function getAllowlist() view returns (uint256[])');
    expect(derive('addToAllowlist', a)).toBeNull();
  });
});

describe('deriveCheck equal sub-rules', () => {
  it('auto:equal/name matches outputs to values by name, reordering', () => {
    const a = abi('function setPair(uint256 _a, address _b)', 'function getPair() view returns (address b, uint256 a)');
    const c = plain(derive('setPair', a));
    expect(c).toMatchObject({ rule: 'auto:equal/name', compare: 'outputs', keyIdx: [], valueIdx: [1, 0] });
  });

  it('auto:equal/1 for a single value matched by type', () => {
    const a = abi('function setLimit(uint128 id, uint256 v)', 'function getLimit(uint128 id) view returns (uint256)');
    const c = plain(derive('setLimit', a));
    expect(c).toMatchObject({ rule: 'auto:equal/1', compare: 'outputs', keyIdx: [0], valueIdx: [1] });
    expect(c.getter.name).toBe('getLimit');
  });

  it('auto:equal/pos for two or more values matched by type', () => {
    const a = abi(
      'function setRange(uint128 id, uint256 lo, uint256 hi)',
      'function getRange(uint128 id) view returns (uint256, uint256)'
    );
    const c = plain(derive('setRange', a));
    expect(c).toMatchObject({ rule: 'auto:equal/pos', compare: 'outputs', keyIdx: [0], valueIdx: [1, 2] });
  });

  it('auto:equal/subset when the getter returns a named subset of the values', () => {
    const a = abi(
      'function setDetails(uint128 id, address owner, uint256 fee, bool on)',
      'function getDetails(uint128 id) view returns (bool on, address owner)'
    );
    const c = plain(derive('setDetails', a));
    expect(c).toMatchObject({ rule: 'auto:equal/subset', compare: 'outputs', keyIdx: [0], valueIdx: [3, 1] });
  });

  it('auto:equal/tupleOut when the getter returns one tuple of the written values', () => {
    const a = abi(
      'function setParams(uint128 id, uint256 a, address b)',
      'struct P { uint256 a; address b; }',
      'function getParams(uint128 id) view returns (P)'
    );
    const c = plain(derive('setParams', a));
    expect(c).toMatchObject({ rule: 'auto:equal/tupleOut', compare: 'tupleOut', keyIdx: [0], valueIdx: [1, 2] });
  });

  it('auto:equal/tupleIn when one written tuple is returned as its components', () => {
    const a = abi(
      'struct P { uint256 a; address b; }',
      'function setParams(uint128 id, P p)',
      'function getParams(uint128 id) view returns (uint256, address)'
    );
    const c = plain(derive('setParams', a));
    expect(c).toMatchObject({ rule: 'auto:equal/tupleIn', compare: 'tupleIn', keyIdx: [0], valueIdx: [1] });
  });

  it('auto:equal/structKeyed when the keys live inside the written struct', () => {
    const a = abi(
      'struct C { uint128 id; uint256 rate; }',
      'function configureThing(C c)',
      'function getThingConfiguration(uint128 id) view returns (C)'
    );
    const c = derive('configureThing', a);
    expect(c).toMatchObject({ rule: 'auto:equal/structKeyed', compare: 'structKeyed', keyFields: [0] });
    expect((c as Extract<Check, { compare: 'structKeyed' }>).getter.name).toBe('getThingConfiguration');
  });

  it('update and configure prefixes derive like set', () => {
    const a = abi(
      'function updateLimit(uint256 v)',
      'function configureCap(uint256 v)',
      'function getLimit() view returns (uint256)',
      'function getCap() view returns (uint256)'
    );
    expect(plain(derive('updateLimit', a)).getter.name).toBe('getLimit');
    expect(plain(derive('configureCap', a)).getter.name).toBe('getCap');
  });
});

describe('deriveCheck getter name candidates', () => {
  const candidates: [string, string][] = [
    ['get<X>', 'getFoo'],
    ['<x>', 'foo'],
    ['is<X>', 'isFoo'],
    ['get<X>s', 'getFoos'],
    ['get<X>Configuration', 'getFooConfiguration'],
    ['get<X>Full', 'getFooFull'],
    ['getRegistered<X>', 'getRegisteredFoo'],
  ];
  it.each(candidates)('finds %s', (_label, getterName) => {
    const a = abi('function setFoo(uint256 v)', `function ${getterName}() view returns (uint256)`);
    expect(plain(derive('setFoo', a)).getter.name).toBe(getterName);
  });

  it('prefers earlier candidates', () => {
    const a = abi(
      'function setFoo(uint256 v)',
      'function getFoos() view returns (uint256)',
      'function foo() view returns (uint256)',
      'function getFoo() view returns (uint256)'
    );
    expect(plain(derive('setFoo', a)).getter.name).toBe('getFoo');
  });
});

describe('deriveCheck key matching', () => {
  it('matches keys by name when the getter key is not a prefix', () => {
    const a = abi('function setLimit(uint256 v, uint128 id)', 'function getLimit(uint128 id) view returns (uint256)');
    expect(plain(derive('setLimit', a))).toMatchObject({ keyIdx: [1], valueIdx: [0] });
  });

  it('falls back to a positional prefix by type when names differ', () => {
    const a = abi('function setLimit(uint128 poolId, uint256 v)', 'function getLimit(uint128 id) view returns (uint256)');
    expect(plain(derive('setLimit', a))).toMatchObject({ keyIdx: [0], valueIdx: [1] });
  });

  it('derives nothing when the getter takes more inputs than the setter provides', () => {
    const a = abi('function setLimit(uint256 v)', 'function getLimit(uint128 id, uint256 x) view returns (uint256)');
    expect(derive('setLimit', a)).toBeNull();
  });
});

describe('deriveCheck auto:fields fallback', () => {
  it('derives one sub-check per value input that has a field getter', () => {
    const a = abi(
      'function createPool(uint128 id, address owner, uint256 fee)',
      'function getPoolOwner(uint128 id) view returns (address)',
      'function getFee(uint128 id) view returns (uint256)'
    );
    const c = derive('createPool', a);
    expect(c).toMatchObject({ rule: 'auto:fields', compare: 'fields' });
    const fields = (c as Extract<Check, { compare: 'fields' }>).fields.map((f) => {
      const p = plain(f);
      return { name: p.getter.name, rule: p.rule, compare: p.compare, keyIdx: p.keyIdx, valueIdx: p.valueIdx };
    });
    expect(fields).toEqual([
      { name: 'getPoolOwner', rule: 'auto:fields', compare: 'outputs', keyIdx: [0], valueIdx: [1] },
      { name: 'getFee', rule: 'auto:fields', compare: 'outputs', keyIdx: [0], valueIdx: [2] },
    ]);
  });

  it('strips leading underscores and new/requested prefixes from the input name', () => {
    const a = abi(
      'function createPool(uint128 id, address _newOwner)',
      'function getPoolOwner(uint128 id) view returns (address)'
    );
    const c = derive('createPool', a) as Extract<Check, { compare: 'fields' }>;
    expect(c.fields).toHaveLength(1);
  });

  it('does not repeat a getter that two inputs both reach', () => {
    const a = abi(
      'function createPool(uint128 id, address owner, address _owner)',
      'function getPoolOwner(uint128 id) view returns (address)'
    );
    const c = derive('createPool', a) as Extract<Check, { compare: 'fields' }>;
    expect(c.fields).toHaveLength(1);
  });

  it('ignores a field getter whose output type differs from the input', () => {
    const a = abi(
      'function createPool(uint128 id, address owner)',
      'function getPoolOwner(uint128 id) view returns (uint256)'
    );
    expect(derive('createPool', a)).toBeNull();
  });
});

describe('deriveCheck null cases', () => {
  it('returns null when the ABI has no getter', () => {
    const a = abi('function setFoo(uint256 v)', 'function unrelated() view returns (uint256)');
    expect(derive('setFoo', a)).toBeNull();
  });

  it('returns null for a function name with no known prefix', () => {
    const a = abi('function doThing(uint256 v)', 'function getThing() view returns (uint256)');
    expect(derive('doThing', a)).toBeNull();
  });

  it('ignores a non-view getX', () => {
    const a = abi('function setFoo(uint256 v)', 'function getFoo() returns (uint256)');
    expect(derive('setFoo', a)).toBeNull();
  });

  it('accepts a pure getter', () => {
    const a = abi('function setFoo(uint256 v)', 'function getFoo() pure returns (uint256)');
    expect(plain(derive('setFoo', a)).getter.name).toBe('getFoo');
  });
});

describe('deriveCheck prefixes', () => {
  it.each([
    ['add', 'addFoo', 'contains'],
    ['addTo', 'addToFoo', 'contains'],
    ['remove', 'removeFoo', 'notContains'],
    ['removeFrom', 'removeFromFoo', 'notContains'],
  ])('%s prefix', (_p, setter, compare) => {
    const a = abi(`function ${setter}(address a)`, 'function getFoo() view returns (address[])');
    expect(plain(derive(setter, a))).toMatchObject({ compare, keyIdx: [], valueIdx: [0] });
  });

  it.each(['create', 'register', 'init', 'initOrUpgrade'])('%s prefix maps to the bare stem', (prefix) => {
    const setter = `${prefix}Foo`;
    const a = abi(`function ${setter}(uint256 v)`, 'function getFoo() view returns (uint256)');
    expect(plain(derive(setter, a)).getter.name).toBe('getFoo');
  });
});

describe('deriveCheck contains does not fall through to equal rules', () => {
  it('addToX with a scalar getter derives nothing', () => {
    const a = abi('function addToX(address a)', 'function getX() view returns (address)');
    expect(derive('addToX', a)).toBeNull();
  });
});

describe('deriveCheck structKeyed key fallback', () => {
  it('finds a key field unique by type when names differ', () => {
    const a = abi(
      'struct C { uint128 rate; address who; }',
      'function configureThing(C c)',
      'function getThingConfiguration(address k) view returns (C)'
    );
    expect(derive('configureThing', a)).toMatchObject({ rule: 'auto:equal/structKeyed', keyFields: [1] });
  });

  it('derives nothing when the key type is ambiguous in the struct', () => {
    const a = abi(
      'struct C { uint128 a; uint128 b; }',
      'function configureThing(C c)',
      'function getThingConfiguration(uint128 k) view returns (C)'
    );
    expect(derive('configureThing', a)).toBeNull();
  });
});
