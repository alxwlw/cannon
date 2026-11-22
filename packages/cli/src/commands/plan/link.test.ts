import * as viem from 'viem';
import { ChainArtifacts, ChainBuilderContext } from '@usecannon/builder';
import fixture from './__fixtures__/PlanFixture.json';
import { checkOrphan, findContractByAddress, linkResults } from './link';
import { ChainReader } from './read';
import { HintsModule } from './hints';
import { StepResult } from './types';

const abi = fixture.abi as viem.Abi;
const ADDR = '0x00000000000000000000000000000000000000aa' as viem.Address;
const NESTED = '0x00000000000000000000000000000000000000bb' as viem.Address;
const A = '0x1111111111111111111111111111111111111111' as viem.Address;
const B = '0x2222222222222222222222222222222222222222' as viem.Address;
const HASH1 = `0x${'01'.repeat(32)}` as viem.Hex;
const HASH2 = `0x${'02'.repeat(32)}` as viem.Hex;

const ctx = {
  contracts: { Fixture: { address: ADDR, abi, contractName: 'PlanFixture' } },
  imports: {
    sub: {
      url: '',
      contracts: { Nested: { address: NESTED, abi, contractName: 'PlanFixture' } },
      imports: { deeper: { url: '', contracts: {}, imports: {} } },
    },
  },
} as unknown as ChainBuilderContext;

const enc = (name: string, args: unknown[]) => viem.encodeFunctionData({ abi, functionName: name, args });
const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function reader(opts: {
  txns?: Record<string, { to: viem.Address | null; input: viem.Hex }>;
  values?: Record<string, unknown>;
}) {
  const r: ChainReader = {
    blockNumber: 10n,
    async call(address, f, args) {
      const key = `${address}|${f.name}|${show(args)}`;
      if (!opts.values || !(key in opts.values)) throw new Error('reverted: ' + key);
      return opts.values[key];
    },
    async getCode() {
      return undefined;
    },
    async getTransaction(hash) {
      const t = opts.txns?.[hash];
      if (!t) throw new Error('transaction not found');
      return t;
    },
  };
  return r;
}

const artifactsOf = (txns: Record<string, { hash: string; events?: Record<string, { args: string[] }[]> }>) =>
  ({
    txns: Object.fromEntries(Object.entries(txns).map(([k, v]) => [k, { events: {}, ...v }])),
  } as unknown as ChainArtifacts);

const base = (over: Partial<Parameters<typeof checkOrphan>[0]>) => ({
  pkg: 'main',
  step: 'invoke.old',
  artifacts: artifactsOf({ old: { hash: HASH1 } }),
  ctx,
  reader: reader({}),
  hints: {} as HintsModule,
  order: 3,
  ...over,
});

describe('findContractByAddress', () => {
  it('finds a top-level contract case-insensitively', () => {
    const f = findContractByAddress(ctx, ADDR.toUpperCase().replace('0X', '0x') as viem.Address);
    expect(f).toEqual({ name: 'Fixture', abi });
  });

  it('descends into nested imports', () => {
    expect(findContractByAddress(ctx, NESTED)).toEqual({ name: 'Nested', abi });
  });

  it('returns null for an unknown address', () => {
    expect(findContractByAddress(ctx, A)).toBeNull();
  });
});

describe('checkOrphan', () => {
  const delay5 = { [`${ADDR}|getDelay|[]`]: 5n };

  it('decodes an invoke orphan and finds it in sync', async () => {
    const rows = await checkOrphan(
      base({ reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) } }, values: delay5 }) })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pkg: 'main',
      step: 'invoke.old',
      kind: 'invoke',
      status: 'orphan',
      order: 3,
      orphan: { effect: 'in-sync', conflicting: false },
      target: { name: 'Fixture', address: ADDR },
      call: { func: 'setDelay', args: ['5'] },
      slot: { address: ADDR, getter: 'getDelay', keys: '[]' },
      check: { rule: 'auto:equal/1', getter: 'getDelay', expected: ['5'], actual: ['5'] },
    });
  });

  it('marks an orphan whose value was overwritten as drift', async () => {
    const rows = await checkOrphan(
      base({
        reader: reader({
          txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [7n]) } },
          values: delay5,
        }),
      })
    );
    expect(rows[0].orphan).toEqual({ effect: 'drift', conflicting: false });
    expect(rows[0].check?.expected).toEqual(['7']);
    expect(rows[0].check?.actual).toEqual(['5']);
  });

  it('returns one skipped row for a step matched by hints.skip', async () => {
    const rows = await checkOrphan(base({ hints: { skip: ['invoke.old'] } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: 'invoke.old', kind: 'invoke', status: 'skipped', order: 3 });
    expect(rows[0].orphan).toBeUndefined();
  });

  it.each(['var.x', 'deploy.y', 'setting.z'])('gives an unchecked orphan row for %s', async (step) => {
    const rows = await checkOrphan(base({ step, artifacts: {} as ChainArtifacts }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step,
      kind: step.split('.')[0],
      status: 'orphan',
      orphan: { effect: 'unchecked', conflicting: false },
    });
  });

  it('does not read the transactions of a non-invoke orphan', async () => {
    const rows = await checkOrphan(
      base({
        step: 'deploy.y',
        artifacts: artifactsOf({ y: { hash: HASH1 } }),
        reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) } }, values: delay5 }),
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].orphan).toEqual({ effect: 'unchecked', conflicting: false });
    expect(rows[0].call).toBeUndefined();
  });

  it('gives one unchecked row for an invoke without transactions', async () => {
    const rows = await checkOrphan(base({ artifacts: artifactsOf({}) }));
    expect(rows).toHaveLength(1);
    expect(rows[0].orphan).toEqual({ effect: 'unchecked', conflicting: false });
  });

  it('gives an unchecked row for a transaction without a hash', async () => {
    const rows = await checkOrphan(base({ artifacts: artifactsOf({ old: { hash: '' } }) }));
    expect(rows).toHaveLength(1);
    expect(rows[0].orphan).toEqual({ effect: 'unchecked', conflicting: false });
  });

  it('gives one row per transaction', async () => {
    const rows = await checkOrphan(
      base({
        artifacts: artifactsOf({ a: { hash: HASH1 }, b: { hash: HASH2 } }),
        reader: reader({
          txns: {
            [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) },
            [HASH2]: { to: ADDR, input: enc('addToAllowlist', [A]) },
          },
          values: { ...delay5, [`${ADDR}|getAllowlist|[]`]: [A] },
        }),
      })
    );
    expect(rows.map((r) => r.call?.func)).toEqual(['setDelay', 'addToAllowlist']);
    expect(rows.map((r) => r.orphan?.effect)).toEqual(['in-sync', 'in-sync']);
  });

  it('turns a failing getTransaction into an error row', async () => {
    const rows = await checkOrphan(base({ reader: reader({ txns: {} }) }));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('orphan');
    expect(rows[0].orphan).toEqual({ effect: 'error', conflicting: false });
    expect(rows[0].detail).toContain('transaction not found');
  });

  it('turns a target outside the record into an error row', async () => {
    const rows = await checkOrphan(base({ reader: reader({ txns: { [HASH1]: { to: A, input: enc('setDelay', [5n]) } } }) }));
    expect(rows[0].orphan?.effect).toBe('error');
    expect(rows[0].detail).toContain(A);
  });

  it('turns undecodable input into an error row', async () => {
    const rows = await checkOrphan(base({ reader: reader({ txns: { [HASH1]: { to: ADDR, input: '0xdeadbeef' } } }) }));
    expect(rows[0].orphan?.effect).toBe('error');
    expect(rows[0].detail).toContain('0xdeadbeef');
  });

  it('gives an unchecked row for a call without a derivable check', async () => {
    const rows = await checkOrphan(
      base({
        reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('initializeThing', [`0x${'ab'.repeat(32)}`]) } } }),
      })
    );
    expect(rows[0].orphan).toEqual({ effect: 'unchecked', conflicting: false });
    expect(rows[0].call?.func).toBe('initializeThing');
    expect(rows[0].check).toBeUndefined();
    // the same text a declared step without a getter carries
    expect(rows[0].detail).toBe('no derivable getter');
  });

  it('lets a hint check first and names the rule hint:<name>', async () => {
    const rows = await checkOrphan(
      base({
        hints: {
          checks: {
            setDelay: async () => ({ status: 'drift', getter: 'custom', expected: 'x', actual: 'y' }),
          },
        },
        reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) } }, values: delay5 }),
      })
    );
    expect(rows[0].orphan?.effect).toBe('drift');
    expect(rows[0].check).toEqual({ rule: 'hint:setDelay', getter: 'custom', expected: 'x', actual: 'y' });
  });

  it('falls back to the derived check when the hint returns null', async () => {
    const rows = await checkOrphan(
      base({
        hints: { checks: { setDelay: async () => null } },
        reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) } }, values: delay5 }),
      })
    );
    expect(rows[0].check?.rule).toBe('auto:equal/1');
    expect(rows[0].orphan?.effect).toBe('in-sync');
  });

  it('turns a throwing hint into an error row', async () => {
    const rows = await checkOrphan(
      base({
        hints: {
          checks: {
            setDelay: async () => {
              throw new Error('hint blew up');
            },
          },
        },
        reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) } }, values: delay5 }),
      })
    );
    expect(rows[0].orphan?.effect).toBe('error');
    expect(rows[0].detail).toBe('hint setDelay: hint blew up');
  });

  it('passes the recorded events of the transaction to the check', async () => {
    // chain holds 5, orphan wrote 7; the recorded event says the contract normalized 7 to 5
    const rows = await checkOrphan(
      base({
        artifacts: artifactsOf({ old: { hash: HASH1, events: { Normalized: [{ args: ['5'] }] } } }),
        reader: reader({ txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [7n]) } }, values: delay5 }),
      })
    );
    expect(rows[0].orphan?.effect).toBe('in-sync');
  });
});

let order = 0;
const slotOf = (getter: string, address: viem.Address = ADDR, keys = '[]') => ({ address, getter, keys });

function declared(step: string, o: Partial<StepResult>): StepResult {
  return { pkg: 'main', step, kind: 'invoke', status: 'in-sync', order: order++, ...o };
}

function orphanRow(step: string, o: Partial<StepResult>): StepResult {
  return {
    pkg: 'main',
    step,
    kind: step.split('.')[0],
    status: 'orphan',
    order: order++,
    orphan: { effect: 'in-sync', conflicting: false },
    ...o,
  };
}

const eq = (step: string, expected: string, actual: string, over: Partial<StepResult> = {}) =>
  declared(step, {
    status: expected === actual ? 'in-sync' : 'drift',
    slot: slotOf('getDelay'),
    check: { rule: 'auto:equal/1', getter: 'getDelay', expected: [expected], actual: [actual] },
    ...over,
  });

const member = (
  step: string,
  rule: 'auto:contains' | 'auto:notContains',
  m: viem.Address,
  chain: viem.Address[],
  over: Partial<StepResult> = {}
) =>
  declared(step, {
    status: (rule === 'auto:contains') === chain.includes(m) ? 'in-sync' : 'drift',
    slot: slotOf('getAllowlist'),
    check: { rule, getter: 'getAllowlist', expected: m, actual: chain },
    ...over,
  });

describe('linkResults: superseded slots', () => {
  beforeEach(() => {
    order = 0;
  });

  it('turns an earlier drift into superseded, the latest row judges', () => {
    const rows = [eq('invoke.first', '0', '5'), eq('invoke.second', '5', '5')];
    const out = linkResults(rows);
    expect(out.map((r) => r.status)).toEqual(['superseded', 'in-sync']);
    expect(out.map((r) => r.step)).toEqual(['invoke.first', 'invoke.second']);
  });

  it('keeps the latest drift as drift', () => {
    const out = linkResults([eq('invoke.first', '0', '5'), eq('invoke.second', '1', '5')]);
    expect(out.map((r) => r.status)).toEqual(['superseded', 'drift']);
  });

  it('does not touch an earlier in-sync row', () => {
    const out = linkResults([eq('invoke.first', '5', '5'), eq('invoke.second', '1', '5')]);
    expect(out.map((r) => r.status)).toEqual(['in-sync', 'drift']);
  });

  it('compares slot addresses case-insensitively', () => {
    const upper = ADDR.toUpperCase().replace('0X', '0x') as viem.Address;
    const out = linkResults([
      eq('invoke.first', '0', '5', { slot: slotOf('getDelay', upper) }),
      eq('invoke.second', '5', '5'),
    ]);
    expect(out[0].status).toBe('superseded');
  });

  it('does not link rows with different keys or getters', () => {
    const out = linkResults([
      eq('invoke.first', '0', '5', { slot: slotOf('getDelay', ADDR, '["1"]') }),
      eq('invoke.second', '5', '5'),
      eq('invoke.third', '0', '5', { slot: slotOf('getValue') }),
    ]);
    expect(out.map((r) => r.status)).toEqual(['drift', 'in-sync', 'drift']);
  });

  it('judges by order, not by array position', () => {
    const late = eq('invoke.late', '5', '5');
    const early = eq('invoke.early', '0', '5');
    late.order = 8;
    early.order = 2;
    const out = linkResults([late, early]);
    expect(out.map((r) => r.status)).toEqual(['in-sync', 'superseded']);
  });

  it('lets a later removeFrom supersede an earlier addTo of the same member', () => {
    const out = linkResults([
      member('invoke.add', 'auto:contains', A, [B]),
      member('invoke.remove', 'auto:notContains', A, [B]),
    ]);
    expect(out.slice(0, 2).map((r) => r.status)).toEqual(['superseded', 'in-sync']);
  });

  it('lets a later addTo supersede an earlier removeFrom of the same member', () => {
    const out = linkResults([
      member('invoke.remove', 'auto:notContains', A, [B, A]),
      member('invoke.add', 'auto:contains', A, [B, A]),
    ]);
    expect(out.slice(0, 2).map((r) => r.status)).toEqual(['superseded', 'in-sync']);
  });

  it('does not supersede adds of different members', () => {
    const out = linkResults([
      member('invoke.addA', 'auto:contains', A, [B]),
      member('invoke.addB', 'auto:contains', B, [B]),
    ]);
    expect(out.slice(0, 2).map((r) => r.status)).toEqual(['drift', 'in-sync']);
  });

  it('never lets a contains row supersede an equal row on the same slot, in both directions', () => {
    const e = eq('invoke.eq', '0', '5', { slot: slotOf('getAllowlist') });
    const c = member('invoke.add', 'auto:contains', A, [B]);
    expect(linkResults([e, c])[0].status).toBe('drift');
    expect(linkResults([c, e].map((r) => ({ ...r, order: r.step === 'invoke.eq' ? 1 : 0 })))[0].status).toBe('drift');
  });

  it('does not mutate its input', () => {
    const rows = [eq('invoke.first', '0', '5'), eq('invoke.second', '5', '5')];
    const snapshot = JSON.stringify(rows);
    linkResults(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe('linkResults: orphans', () => {
  beforeEach(() => {
    order = 0;
  });

  it('explains a declared drift by an orphan that wrote the live value', async () => {
    const orphans = await checkOrphan(
      base({
        step: 'invoke.old',
        order: 9,
        reader: reader({
          txns: { [HASH1]: { to: ADDR, input: enc('setDelay', [5n]) } },
          values: { [`${ADDR}|getDelay|[]`]: 5n },
        }),
      })
    );
    const out = linkResults([eq('invoke.setDelay', '0', '5'), ...orphans]);
    expect(out[0].status).toBe('drift');
    expect(out[0].explainedBy).toBe('invoke.old');
    expect(out[1].orphan).toEqual({ effect: 'in-sync', conflicting: true });
  });

  it('links hint rows whose values are bigints without throwing', () => {
    // a hint that returns read() results directly: bigints on both rows of one slot
    const S = slotOf('getDelay');
    const d = declared('invoke.setDelay', {
      status: 'drift',
      slot: S,
      check: { rule: 'hint:setDelay', getter: 'getDelay', expected: 0n, actual: 7n },
    });
    const o = orphanRow('invoke.old', {
      slot: S,
      check: { rule: 'hint:setDelay', getter: 'getDelay', expected: 7n, actual: 7n },
    });
    const out = linkResults([d, o]);
    expect(out[0].explainedBy).toBe('invoke.old');
    expect(out[1].orphan).toEqual({ effect: 'in-sync', conflicting: true });
  });

  it('does not explain a drift when the orphan wrote another value', () => {
    const o = orphanRow('invoke.old', {
      slot: slotOf('getDelay'),
      check: { rule: 'auto:equal/1', getter: 'getDelay', expected: ['7'], actual: ['5'] },
    });
    const out = linkResults([eq('invoke.setDelay', '0', '5'), o]);
    expect(out[0].explainedBy).toBeUndefined();
    expect(out[1].orphan?.conflicting).toBe(false);
  });

  it('does not link an orphan on another slot', () => {
    const o = orphanRow('invoke.old', {
      slot: slotOf('getValue'),
      check: { rule: 'auto:equal/1', getter: 'getValue', expected: ['5'], actual: ['5'] },
    });
    const out = linkResults([eq('invoke.setDelay', '0', '5'), o]);
    expect(out[0].explainedBy).toBeUndefined();
    expect(out[1].orphan?.conflicting).toBe(false);
  });

  it('matches orphan slots case-insensitively', () => {
    const upper = ADDR.toUpperCase().replace('0X', '0x') as viem.Address;
    const o = orphanRow('invoke.old', {
      slot: slotOf('getDelay', upper),
      check: { rule: 'auto:equal/1', getter: 'getDelay', expected: ['5'], actual: ['5'] },
    });
    const out = linkResults([eq('invoke.setDelay', '0', '5'), o]);
    expect(out[0].explainedBy).toBe('invoke.old');
  });

  it('never marks var, setting, deploy, contract or router orphans conflicting', () => {
    const slotty = {
      slot: slotOf('getDelay'),
      check: { rule: 'auto:equal/1', getter: 'getDelay', expected: ['5'], actual: ['5'] },
    };
    const kinds = ['var.x', 'setting.s', 'deploy.y', 'contract.c', 'router.r'];
    const out = linkResults([eq('invoke.setDelay', '0', '5'), ...kinds.map((k) => orphanRow(k, slotty))]);
    expect(out[0].explainedBy).toBeUndefined();
    expect(out.slice(1).map((r) => r.orphan?.conflicting)).toEqual([false, false, false, false, false]);
  });

  it('leaves a skipped orphan as skipped', () => {
    const s: StepResult = { pkg: 'main', step: 'invoke.old', kind: 'invoke', status: 'skipped', order: 5 };
    expect(linkResults([s])).toEqual([s]);
  });
});

describe('linkResults: enumerations', () => {
  beforeEach(() => {
    order = 0;
  });

  it('adds a drift row for chain members nobody declared', () => {
    const out = linkResults([member('invoke.addA', 'auto:contains', A, [A, B])]);
    expect(out).toHaveLength(2);
    const e = out[1];
    expect(e).toMatchObject({
      pkg: 'main',
      step: '(enumeration)',
      kind: 'enumeration',
      status: 'drift',
      slot: slotOf('getAllowlist'),
      check: { rule: 'enum:contains', getter: 'getAllowlist', expected: [A], actual: [A, B] },
    });
    expect(e.detail).toContain('undeclared member(s)');
    expect(e.detail).toContain(B);
    expect(e.detail).not.toContain(A);
    expect(e.order).toBeGreaterThan(out[0].order);
    expect(e.explainedBy).toBeUndefined();
  });

  it('adds an in-sync row when every chain member is declared', () => {
    const out = linkResults([
      member('invoke.addA', 'auto:contains', A, [A, B]),
      member('invoke.addB', 'auto:contains', B, [A, B]),
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({
      step: '(enumeration)',
      kind: 'enumeration',
      status: 'in-sync',
      check: { rule: 'enum:contains', expected: [A, B], actual: [A, B] },
    });
  });

  it('puts the enumeration row after every existing row', () => {
    const rows = [member('invoke.addA', 'auto:contains', A, [A]), eq('invoke.setDelay', '5', '5')];
    rows[0].order = 40;
    rows[1].order = 2;
    const out = linkResults(rows);
    expect(out[2].order).toBeGreaterThan(40);
  });

  it('groups by slot, case-insensitively, and reports each list once', () => {
    const upper = ADDR.toUpperCase().replace('0X', '0x') as viem.Address;
    const out = linkResults([
      member('invoke.addA', 'auto:contains', A, [A, B]),
      member('invoke.addB', 'auto:contains', B, [A, B], { slot: slotOf('getAllowlist', upper) }),
    ]);
    expect(out.filter((r) => r.kind === 'enumeration')).toHaveLength(1);
    expect(out[2].status).toBe('in-sync');
  });

  it('ignores notContains rows and rows without a contains rule', () => {
    const out = linkResults([member('invoke.rm', 'auto:notContains', A, [B]), eq('invoke.setDelay', '5', '5')]);
    expect(out.filter((r) => r.kind === 'enumeration')).toHaveLength(0);
  });

  it('explains the undeclared member by an orphan add and marks that orphan conflicting', async () => {
    const orphans = await checkOrphan(
      base({
        step: 'invoke.oldAdd',
        order: 9,
        reader: reader({
          txns: { [HASH1]: { to: ADDR, input: enc('addToAllowlist', [B]) } },
          values: { [`${ADDR}|getAllowlist|[]`]: [A, B] },
        }),
      })
    );
    const out = linkResults([member('invoke.addA', 'auto:contains', A, [A, B]), ...orphans]);
    const e = out.find((r) => r.kind === 'enumeration')!;
    expect(e.status).toBe('drift');
    expect(e.explainedBy).toBe('invoke.oldAdd');
    expect(out[1].orphan).toEqual({ effect: 'in-sync', conflicting: true });
  });

  it('does not mark an orphan that added a declared member', () => {
    const o = orphanRow('invoke.oldAdd', {
      slot: slotOf('getAllowlist'),
      check: { rule: 'auto:contains', getter: 'getAllowlist', expected: A, actual: [A] },
    });
    const out = linkResults([member('invoke.addA', 'auto:contains', A, [A]), o]);
    expect(out[1].orphan?.conflicting).toBe(false);
  });

  it('names an orphan once when two of its transactions add the same extra member', async () => {
    const orphans = await checkOrphan(
      base({
        step: 'invoke.oldAdd',
        order: 9,
        artifacts: artifactsOf({ a: { hash: HASH1 }, b: { hash: HASH2 } }),
        reader: reader({
          txns: {
            [HASH1]: { to: ADDR, input: enc('addToAllowlist', [B]) },
            [HASH2]: { to: ADDR, input: enc('addToAllowlist', [B]) },
          },
          values: { [`${ADDR}|getAllowlist|[]`]: [A, B] },
        }),
      })
    );
    expect(orphans).toHaveLength(2);
    const out = linkResults([member('invoke.addA', 'auto:contains', A, [A, B]), ...orphans]);
    expect(out.find((r) => r.kind === 'enumeration')?.explainedBy).toBe('invoke.oldAdd');
  });

  it('gives each list its own enumeration row with increasing order', () => {
    const second = slotOf('getAllowlist', NESTED);
    const out = linkResults([
      member('invoke.addA', 'auto:contains', A, [A]),
      member('invoke.addB', 'auto:contains', B, [B], { slot: second }),
    ]);
    const enums = out.filter((r) => r.kind === 'enumeration');
    expect(enums.map((r) => r.slot?.address)).toEqual([ADDR, NESTED]);
    expect(enums[1].order).toBe(enums[0].order + 1);
    expect(enums[0].order).toBeGreaterThan(out[1].order);
  });

  it('treats a chain list that is not an array as empty', () => {
    const row = member('invoke.addA', 'auto:contains', A, [A]);
    row.check = { rule: 'auto:contains', getter: 'getAllowlist', expected: A, actual: 'not a list' };
    const e = linkResults([row])[1];
    expect(e.status).toBe('in-sync');
    expect(e.check?.actual).toEqual([]);
  });

  it('shows a non-string member as JSON in the detail', () => {
    const row = declared('invoke.addPair', {
      slot: slotOf('getPairs'),
      check: {
        rule: 'auto:contains',
        getter: 'getPairs',
        expected: ['1', '2'],
        actual: [
          ['1', '2'],
          ['3', '4'],
        ],
      },
    });
    const e = linkResults([row])[1];
    expect(e.status).toBe('drift');
    expect(e.detail).toBe('undeclared member(s): ["3","4"]');
  });
});
