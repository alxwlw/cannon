import { bigintReplacer } from './normalize';
import { PendingChange, PlanReport, StepResult } from './types';

const MAX_CELL = 200;

export function buildReport(a: {
  pkg: string;
  chainId: number;
  block: bigint;
  steps: StepResult[];
  pending: PendingChange[];
  generatedAt?: Date;
}): PlanReport {
  const counts: Record<string, number> = {};
  for (const s of a.steps) {
    const key = `${s.kind}:${s.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  for (const p of a.pending) {
    const key = `pending:${p.change}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const summary: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) summary[key] = counts[key];

  return {
    version: 1,
    package: a.pkg,
    chainId: a.chainId,
    block: a.block.toString(),
    mode: 'record',
    generatedAt: (a.generatedAt ?? new Date()).toISOString(),
    summary,
    steps: a.steps,
    pending: a.pending,
  };
}

export function toJson(report: PlanReport): string {
  return JSON.stringify(report, bigintReplacer, 2) + '\n';
}

export function exitCodeOf(report: PlanReport): 0 | 2 {
  const drift = report.steps.some((s) => s.status === 'drift' || s.orphan?.conflicting === true);
  const pending = report.pending.some((p) => p.change === 'added' || p.change === 'changed' || p.change === 'removed');
  return drift || pending ? 2 : 0;
}

/** One table cell: truncated first, then escaped so that a value can never break the table. */
function cell(text: string | undefined): string {
  if (!text) return '';
  // the cut never splits a surrogate pair: a lone half would print as U+FFFD
  const clipped = text.length > MAX_CELL ? text.slice(0, MAX_CELL - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text;
  return clipped.replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ');
}

function json(value: unknown): string | undefined {
  return JSON.stringify(value, bigintReplacer);
}

const ROW_HEADER = ['package', 'step', 'target', 'call', 'getter', 'expected', 'actual', 'detail'];

function row(s: StepResult): string {
  const target = s.target ? `${s.target.name} (${s.target.address})` : undefined;
  const call = s.call ? `${s.call.func}(${s.call.args.map((x) => json(x)).join(', ')})` : undefined;
  const detail = [
    s.orphan ? `effect: ${s.orphan.effect}, ${s.orphan.conflicting ? 'conflicting' : 'not conflicting'}` : '',
    s.explainedBy ? `explained by ${s.explainedBy}` : '',
    s.detail ?? '',
  ]
    .filter((p) => p !== '')
    .join('; ');
  const cells = [
    s.pkg,
    s.step,
    target,
    call,
    s.check?.getter ?? s.slot?.getter,
    json(s.check?.expected),
    json(s.check?.actual),
    detail,
  ];
  return `| ${cells.map(cell).join(' | ')} |`;
}

function table(header: string[], rows: string[]): string[] {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows];
}

function section(title: string, steps: StepResult[]): string[] {
  if (steps.length === 0) return [];
  return [`## ${title}`, '', ...table(ROW_HEADER, steps.map(row)), ''];
}

export function toMarkdown(report: PlanReport): string {
  const lines: string[] = [
    `# cannon plan — ${report.package}`,
    '',
    `chain id ${report.chainId}, block ${report.block}, generated ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    ...table(
      ['kind:status', 'count'],
      Object.entries(report.summary).map(([k, n]) => `| ${cell(k)} | ${n} |`)
    ),
    '',
  ];

  lines.push(
    ...section(
      'Drift',
      report.steps.filter((s) => s.status === 'drift')
    )
  );
  // Array.prototype.sort is stable: conflicting orphans first, input order inside each group.
  const orphans = report.steps
    .filter((s) => s.status === 'orphan')
    .sort((x, y) => Number(y.orphan?.conflicting === true) - Number(x.orphan?.conflicting === true));
  lines.push(...section('Orphans', orphans));

  if (report.pending.length > 0) {
    lines.push(
      '## Will change',
      '',
      ...table(
        ['step', 'change'],
        report.pending.map((p) => `| ${cell(p.step)} | ${p.change} |`)
      ),
      '',
      'Contract sources are not compiled: a changed contract source is not shown here.'
    );
    if (report.pending.some((p) => p.change === 'removed')) {
      lines.push('', 'Removing a step from the cannonfile does not undo its effect on chain.');
    }
    lines.push('');
  }

  lines.push(
    ...section(
      'Not checked',
      report.steps.filter((s) => s.status === 'unchecked' || s.status === 'skipped' || s.status === 'error')
    )
  );

  return lines.join('\n').replace(/\n+$/, '') + '\n';
}
