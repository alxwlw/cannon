import { buildReport, exitCodeOf, toJson, toMarkdown } from './report';
import { PendingChange, PlanReport, StepResult } from './types';

const ADDR = '0x00000000000000000000000000000000000000a1' as const;
const ADDR2 = '0x00000000000000000000000000000000000000b2' as const;

function step(over: Partial<StepResult> = {}): StepResult {
  return { pkg: 'demo:1.0.0', step: 'invoke.setup', kind: 'invoke', status: 'in-sync', order: 0, ...over };
}

function report(steps: StepResult[] = [], pending: PendingChange[] = []): PlanReport {
  return buildReport({
    pkg: 'demo:1.0.0',
    chainId: 31337,
    block: 123n,
    steps,
    pending,
    generatedAt: new Date('2026-01-02T03:04:05.000Z'),
  });
}

function driftStep(over: Partial<StepResult> = {}): StepResult {
  return step({
    status: 'drift',
    target: { name: 'Thing', address: ADDR },
    call: { func: 'setValue', args: [7n, 'abc'] },
    check: { rule: 'r', getter: 'value', expected: '7', actual: '8' },
    ...over,
  });
}

function orphan(name: string, conflicting: boolean, over: Partial<StepResult> = {}): StepResult {
  return step({
    step: name,
    status: 'orphan',
    orphan: { effect: 'drift', conflicting },
    ...over,
  });
}

describe('buildReport', () => {
  it('fills the header fields', () => {
    const r = report();
    expect(r.version).toBe(1);
    expect(r.package).toBe('demo:1.0.0');
    expect(r.chainId).toBe(31337);
    expect(r.block).toBe('123');
    expect(r.mode).toBe('record');
    expect(r.generatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('defaults generatedAt to now', () => {
    const before = Date.now();
    const r = buildReport({ pkg: 'demo', chainId: 1, block: 1n, steps: [], pending: [] });
    const at = new Date(r.generatedAt).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('counts kind:status and pending:change, keys sorted', () => {
    const r = report(
      [
        step({ kind: 'invoke', status: 'in-sync' }),
        step({ kind: 'invoke', status: 'in-sync' }),
        step({ kind: 'deploy', status: 'drift' }),
        step({ kind: 'invoke', status: 'error' }),
      ],
      [
        { step: 'a', change: 'removed' },
        { step: 'b', change: 'added' },
        { step: 'c', change: 'added' },
      ]
    );
    expect(r.summary).toEqual({
      'deploy:drift': 1,
      'invoke:error': 1,
      'invoke:in-sync': 2,
      'pending:added': 2,
      'pending:removed': 1,
    });
    expect(Object.keys(r.summary)).toEqual([
      'deploy:drift',
      'invoke:error',
      'invoke:in-sync',
      'pending:added',
      'pending:removed',
    ]);
  });

  it('keeps steps and pending as given', () => {
    const steps = [step({ step: 'x' })];
    const pending: PendingChange[] = [{ step: 'y', change: 'changed' }];
    const r = report(steps, pending);
    expect(r.steps).toEqual(steps);
    expect(r.pending).toEqual(pending);
  });
});

describe('exitCodeOf', () => {
  it('is 0 without rows', () => {
    expect(exitCodeOf(report())).toBe(0);
  });

  it('is 2 for a drift step', () => {
    expect(exitCodeOf(report([driftStep()]))).toBe(2);
  });

  it('is 0 for a non-conflicting orphan only', () => {
    expect(exitCodeOf(report([orphan('o', false)]))).toBe(0);
  });

  it('is 2 for a conflicting orphan', () => {
    expect(exitCodeOf(report([orphan('o', true)]))).toBe(2);
  });

  it('is 0 for may-change only', () => {
    expect(exitCodeOf(report([], [{ step: 's', change: 'may-change' }]))).toBe(0);
  });

  it.each(['added', 'changed', 'removed'] as const)('is 2 for a %s pending change', (change) => {
    expect(exitCodeOf(report([], [{ step: 's', change }]))).toBe(2);
  });

  it('is 0 for unchecked, skipped, superseded, in-sync and error only', () => {
    const steps = (['unchecked', 'skipped', 'superseded', 'in-sync', 'error'] as const).map((status) => step({ status }));
    expect(exitCodeOf(report(steps))).toBe(0);
  });
});

describe('toJson', () => {
  it('serializes bigints, nested too, as decimal strings and carries the version', () => {
    const r = report([
      driftStep({
        call: { func: 'f', args: [[1n, { deep: 2n }]] },
        check: { rule: 'r', getter: 'g', expected: { n: [3n] }, actual: 5n },
      }),
    ]);
    const text = toJson(r);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('  "version": 1,');
    const parsed = JSON.parse(text);
    expect(parsed.steps[0].check.actual).toBe('5');
    expect(parsed.steps[0].check.expected).toEqual({ n: ['3'] });
    expect(parsed.steps[0].call.args).toEqual([['1', { deep: '2' }]]);
    expect(parsed.block).toBe('123');
  });
});

describe('toMarkdown', () => {
  it('writes the header, the summary and nothing else for an in-sync report', () => {
    const md = toMarkdown(report([step()]));
    expect(md).toContain('# cannon plan — demo:1.0.0\n');
    expect(md).toContain('chain id 31337, block 123, generated 2026-01-02T03:04:05.000Z');
    expect(md).toContain('## Summary');
    expect(md).toContain('| invoke:in-sync | 1 |');
    expect(md).not.toContain('## Drift');
    expect(md).not.toContain('## Orphans');
    expect(md).not.toContain('## Will change');
    expect(md).not.toContain('## Not checked');
    expect(md.endsWith('|\n')).toBe(true);
  });

  it('renders a drift row with every column', () => {
    const md = toMarkdown(report([driftStep({ explainedBy: 'other.step', detail: 'slot moved' })]));
    expect(md).toContain('## Drift');
    expect(md).toContain('| package | step | target | call | getter | expected | actual | detail |');
    expect(md).toContain(
      `| demo:1.0.0 | invoke.setup | Thing (${ADDR}) | setValue("7", "abc") | value | "7" | "8" | explained by other.step; slot moved |`
    );
  });

  it('renders a bigint call argument and bigint values as decimal strings', () => {
    const md = toMarkdown(
      report([
        driftStep({
          call: { func: 'f', args: [[1n, { deep: 2n }]] },
          check: { rule: 'r', getter: 'g', expected: { n: [3n] }, actual: 5n },
        }),
      ])
    );
    expect(md).toContain('f(["1",{"deep":"2"}])');
    expect(md).toContain('| {"n":["3"]} | "5" |');
  });

  it('falls back to the slot getter and leaves missing values empty', () => {
    const md = toMarkdown(
      report([
        step({
          status: 'unchecked',
          slot: { address: ADDR, getter: 'owner', keys: '[]' },
        }),
      ])
    );
    expect(md).toContain('| demo:1.0.0 | invoke.setup |  |  | owner |  |  |  |');
  });

  it('prefers the check getter over the slot getter', () => {
    const md = toMarkdown(report([driftStep({ slot: { address: ADDR2, getter: 'slotGetter', keys: '[]' } })]));
    expect(md).toContain('| value |');
    expect(md).not.toContain('slotGetter');
  });

  it('puts conflicting orphans first, keeping input order inside each group', () => {
    const md = toMarkdown(
      report([
        orphan('first-clean', false),
        orphan('first-conflict', true),
        orphan('second-clean', false),
        orphan('second-conflict', true),
      ])
    );
    const order = ['first-conflict', 'second-conflict', 'first-clean', 'second-clean'].map((n) => md.indexOf(`| ${n} |`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain('effect: drift, conflicting');
    expect(md).toContain('effect: drift, not conflicting');
  });

  it('keeps input order within the drift section', () => {
    const md = toMarkdown(report([driftStep({ step: 'zz' }), driftStep({ step: 'aa' })]));
    expect(md.indexOf('| zz |')).toBeLessThan(md.indexOf('| aa |'));
  });

  it('lists unchecked, skipped and error under Not checked, and in-sync and superseded nowhere', () => {
    const md = toMarkdown(
      report([
        step({ step: 'row-unchecked', status: 'unchecked' }),
        step({ step: 'row-skipped', status: 'skipped' }),
        step({ step: 'row-error', status: 'error', detail: 'rpc failed' }),
        step({ step: 'row-insync', status: 'in-sync' }),
        step({ step: 'row-superseded', status: 'superseded' }),
      ])
    );
    const notChecked = md.slice(md.indexOf('## Not checked'));
    expect(notChecked).toContain('| row-unchecked |');
    expect(notChecked).toContain('| row-skipped |');
    expect(notChecked).toContain('| row-error |');
    expect(notChecked).toContain('rpc failed');
    expect(md).not.toContain('row-insync');
    expect(md).not.toContain('row-superseded');
    expect(md).toContain('| invoke:superseded | 1 |');
    expect(md).not.toContain('## Drift');
  });

  it('omits Will change without pending entries and shows neither note', () => {
    const md = toMarkdown(report([driftStep()]));
    expect(md).not.toContain('## Will change');
    expect(md).not.toContain('Contract sources are not compiled');
    expect(md).not.toContain('does not undo its effect');
  });

  it('shows the sources note for any pending change and the removal line only for removed', () => {
    const md = toMarkdown(report([], [{ step: 'invoke.x', change: 'may-change' }]));
    expect(md).toContain('## Will change');
    expect(md).toContain('| step | change |');
    expect(md).toContain('| invoke.x | may-change |');
    expect(md).toContain('Contract sources are not compiled: a changed contract source is not shown here.');
    expect(md).not.toContain('Removing a step from the cannonfile does not undo its effect on chain.');
    expect(md).toContain('| pending:may-change | 1 |');
  });

  it('shows the removal line when a step is removed', () => {
    const md = toMarkdown(
      report(
        [],
        [
          { step: 'invoke.x', change: 'added' },
          { step: 'invoke.y', change: 'removed' },
        ]
      )
    );
    expect(md).toContain('| invoke.y | removed |');
    expect(md).toContain('Removing a step from the cannonfile does not undo its effect on chain.');
    expect(md).toContain('Contract sources are not compiled: a changed contract source is not shown here.');
  });

  it('orders the sections Drift, Orphans, Will change, Not checked', () => {
    const md = toMarkdown(
      report([step({ status: 'unchecked' }), orphan('o', true), driftStep()], [{ step: 's', change: 'added' }])
    );
    const at = ['## Summary', '## Drift', '## Orphans', '## Will change', '## Not checked'].map((h) => md.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('truncates a 500-char value to 200 chars ending with an ellipsis', () => {
    const md = toMarkdown(
      report([driftStep({ check: { rule: 'r', getter: 'g', expected: 'x'.repeat(500), actual: 'y' } })])
    );
    const cellText = md
      .split('\n')
      .find((l) => l.includes('xxx'))!
      .split(' | ')[5];
    expect(cellText.length).toBe(200);
    expect(cellText.endsWith('…')).toBe(true);
    expect(cellText).toBe('"' + 'x'.repeat(198) + '…');
  });

  it('keeps a 200-char cell whole and truncates a 201-char one', () => {
    // compact JSON adds two quote characters
    const at200 = 'x'.repeat(198);
    const at201 = 'x'.repeat(199);
    const mdA = toMarkdown(report([driftStep({ check: { rule: 'r', getter: 'g', expected: at200, actual: 'y' } })]));
    const mdB = toMarkdown(report([driftStep({ check: { rule: 'r', getter: 'g', expected: at201, actual: 'y' } })]));
    expect(mdA).toContain(`| "${at200}" |`);
    expect(mdA).not.toContain('…');
    expect(mdB).not.toContain(`| "${at201}" |`);
    expect(mdB).toContain(`| "${'x'.repeat(198)}… |`);
  });

  it('truncates before escaping, so escapes may lengthen the cell', () => {
    const md = toMarkdown(
      report([driftStep({ check: { rule: 'r', getter: 'g', expected: '|'.repeat(300), actual: 'y' } })])
    );
    expect(md).toContain('"' + '\\|'.repeat(198) + '… |');
  });

  it('escapes pipes and flattens newlines so a value cannot break the table', () => {
    const md = toMarkdown(
      report([
        driftStep({
          check: { rule: 'r', getter: 'g', expected: 'a|b', actual: 'c' },
          detail: 'line one\nline two\r\nline three',
        }),
      ])
    );
    expect(md).toContain('"a\\|b"');
    expect(md).toContain('line one line two line three');
    const driftRow = md.split('\n').find((l) => l.includes('line one'))!;
    // 8 columns -> 9 unescaped pipes
    expect(driftRow.replace(/\\\|/g, '').split('|').length - 1).toBe(9);
  });

  it('escapes a pipe in a pending step name', () => {
    const md = toMarkdown(report([], [{ step: 'a|b', change: 'added' }]));
    expect(md).toContain('| a\\|b | added |');
  });
});
