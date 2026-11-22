import * as viem from 'viem';

export type StepStatus = 'in-sync' | 'drift' | 'unchecked' | 'skipped' | 'superseded' | 'orphan' | 'error';

export interface Slot {
  address: viem.Address;
  getter: string;
  /** JSON of the normalized key arguments */
  keys: string;
}

export interface CheckOutcome {
  status: 'in-sync' | 'drift' | 'error';
  getter: string;
  expected: unknown;
  actual: unknown;
  slot?: Slot;
  detail?: string;
}

export interface StepResult {
  pkg: string;
  step: string;
  kind: string;
  status: StepStatus;
  order: number;
  target?: { name: string; address: viem.Address };
  call?: { func: string; args: unknown[] };
  check?: { rule: string; getter: string; expected: unknown; actual: unknown };
  slot?: Slot;
  orphan?: { effect: 'in-sync' | 'drift' | 'unchecked' | 'error'; conflicting: boolean };
  explainedBy?: string;
  detail?: string;
}

export interface PendingChange {
  step: string;
  change: 'added' | 'changed' | 'removed' | 'may-change';
}

export interface PlanReport {
  version: 1;
  package: string;
  chainId: number;
  block: string;
  mode: 'record';
  generatedAt: string;
  summary: Record<string, number>;
  steps: StepResult[];
  pending: PendingChange[];
}

export type Check =
  | {
      rule: string;
      compare: 'outputs' | 'tupleOut' | 'tupleIn' | 'contains' | 'notContains';
      getter: viem.AbiFunction;
      keyIdx: number[];
      valueIdx: number[];
    }
  | {
      rule: 'builtin:nominateNewOwner';
      compare: 'ownerOrNominated';
      getter: viem.AbiFunction;
      alt?: viem.AbiFunction;
      keyIdx: [];
      valueIdx: [0];
    }
  | { rule: 'auto:equal/structKeyed'; compare: 'structKeyed'; getter: viem.AbiFunction; keyFields: number[] }
  | { rule: 'auto:fields'; compare: 'fields'; fields: Check[] };
