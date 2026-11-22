import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { types } from 'node:util';
import * as viem from 'viem';
import { ChainReader } from './read';
import { isSkipped, loadHints, makeRead } from './hints';

const fx = (name: string) => path.join(__dirname, '__fixtures__', name);

function expectShape(h: Awaited<ReturnType<typeof loadHints>>) {
  expect(Object.keys(h.checks!)).toEqual(['setThing']);
  expect(typeof h.checks!.setThing).toBe('function');
  expect(h.skip).toHaveLength(2);
  expect(h.skip![0]).toBe('invoke.initializeThing');
  expect(types.isRegExp(h.skip![1])).toBe(true);
  expect((h.skip![1] as RegExp).source).toBe('^invoke\\.setOther.*Name$');
  expect(h.enumerations).toHaveLength(1);
}

describe('loadHints', () => {
  it('returns {} when no file is given', async () => {
    expect(await loadHints(undefined)).toEqual({});
  });

  it('loads a .cjs module', async () => {
    expectShape(await loadHints(fx('hints.cjs')));
  });

  it('loads a .mjs module (default export) through the real import path', async () => {
    expectShape(await loadHints(fx('hints.mjs')));
  });

  it('falls back to the module namespace when there is no default export', async () => {
    const h = await loadHints(fx('hints-named.mjs'));
    expect(h.skip).toEqual(['invoke.namedOnly']);
  });

  it('resolves a relative path against process.cwd()', async () => {
    const h = await loadHints(path.relative(process.cwd(), fx('hints.cjs')));
    expectShape(h);
  });

  it('rejects checks that are not an object of functions', async () => {
    await expect(loadHints(fx('hints-bad.cjs'))).rejects.toThrow(/^--hints .*hints-bad\.cjs: checks\.a is not a function/);
  });

  it('reports a missing file with the --hints prefix', async () => {
    await expect(loadHints(fx('nope.cjs'))).rejects.toThrow(/^--hints .*nope\.cjs: /);
  });

  describe('shape validation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-'));
    const write = (name: string, body: string) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, body);
      return f;
    };

    it('rejects skip that is not an array', async () => {
      const f = write('a.cjs', 'module.exports = { skip: "x" };');
      await expect(loadHints(f)).rejects.toThrow(/: skip must be an array of strings or RegExps/);
    });

    it('rejects a skip entry that is neither string nor RegExp', async () => {
      const f = write('b.cjs', 'module.exports = { skip: ["ok", 1] };');
      await expect(loadHints(f)).rejects.toThrow(/: skip must be an array of strings or RegExps/);
    });

    it('rejects enumerations that are not an array of functions', async () => {
      const f = write('c.cjs', 'module.exports = { enumerations: [1] };');
      await expect(loadHints(f)).rejects.toThrow(/: enumerations must be an array of functions/);
    });

    it('rejects checks that is not an object', async () => {
      const f = write('d.cjs', 'module.exports = { checks: [] };');
      await expect(loadHints(f)).rejects.toThrow(/: checks must be an object of functions/);
    });

    it('rejects a module that exports a non-object', async () => {
      const f = write('e.cjs', 'module.exports = 5;');
      await expect(loadHints(f)).rejects.toThrow(/: module must export an object/);
    });
  });
});

describe('isSkipped', () => {
  const hints = { skip: ['invoke.a', /^invoke\.b/] };

  it('matches a string exactly', () => {
    expect(isSkipped(hints, 'invoke.a')).toBe(true);
    expect(isSkipped(hints, 'invoke.ab')).toBe(false);
  });

  it('matches a RegExp', () => {
    expect(isSkipped(hints, 'invoke.bx')).toBe(true);
  });

  it('does not skip other steps', () => {
    expect(isSkipped(hints, 'invoke.c')).toBe(false);
  });

  it('skips nothing without a skip list', () => {
    expect(isSkipped({}, 'invoke.a')).toBe(false);
  });

  it('is not poisoned by a global RegExp lastIndex', () => {
    const h = { skip: [/^invoke\.g/g] };
    expect(isSkipped(h, 'invoke.g1')).toBe(true);
    expect(isSkipped(h, 'invoke.g1')).toBe(true);
  });
});

describe('makeRead', () => {
  const addr = '0x0000000000000000000000000000000000000001' as viem.Address;
  const fakeReader = () => {
    const calls: { address: viem.Address; fn: viem.AbiFunction; args: unknown[] }[] = [];
    const reader = {
      blockNumber: 1n,
      call: async (address: viem.Address, fn: viem.AbiFunction, args: unknown[]) => {
        calls.push({ address, fn, args });
        return 'result';
      },
    } as unknown as ChainReader;
    return { reader, calls };
  };

  it('parses a human-readable signature', async () => {
    const { reader, calls } = fakeReader();
    const out = await makeRead(reader)(addr, 'function getThing(uint256 id) view returns (address)', [7n]);
    expect(out).toBe('result');
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(addr);
    expect(calls[0].fn).toEqual(viem.parseAbiItem('function getThing(uint256 id) view returns (address)'));
    expect(calls[0].args).toEqual([7n]);
  });

  it('accepts a signature without the leading function keyword', async () => {
    const { reader, calls } = fakeReader();
    await makeRead(reader)(addr, 'getThing(uint256 id) view returns (address)', [7n]);
    expect(calls[0].fn.name).toBe('getThing');
    expect(calls[0].fn.type).toBe('function');
  });

  it('passes an AbiFunction through unchanged', async () => {
    const { reader, calls } = fakeReader();
    const fn = viem.parseAbiItem('function getThing() view returns (uint256)') as viem.AbiFunction;
    await makeRead(reader)(addr, fn, []);
    expect(calls[0].fn).toBe(fn);
  });

  it('throws on a signature that is not a function', async () => {
    const { reader, calls } = fakeReader();
    await expect(makeRead(reader)(addr, 'event Thing(uint256 a)', [])).rejects.toThrow(/not a function/);
    expect(calls).toHaveLength(0);
  });
});
