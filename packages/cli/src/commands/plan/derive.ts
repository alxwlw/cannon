import * as viem from 'viem';
import { Check } from './types';

type Param = viem.AbiParameter;
type Plain = Extract<Check, { compare: 'outputs' | 'tupleOut' | 'tupleIn' | 'contains' | 'notContains' }>;

const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function typeKey(p: Param): string {
  const components = (p as { components?: readonly Param[] }).components;
  return p.type.startsWith('tuple') && components ? `${p.type}<${components.map(typeKey).join(',')}>` : p.type;
}

const sameTypes = (a: readonly Param[], b: readonly Param[]) =>
  a.length === b.length && a.every((p, i) => typeKey(p) === typeKey(b[i]));

const isView = (f: viem.Abi[number]): f is viem.AbiFunction =>
  f.type === 'function' && (f.stateMutability === 'view' || f.stateMutability === 'pure');

function stripName(n: string) {
  return n.replace(/^_+/, '').replace(/^(new|requested)([A-Z])/, (_m, _a, b: string) => b.toLowerCase());
}

function stemOf(name: string): { mode: 'contains' | 'notContains' | 'equal' | 'fields'; stem: string } | null {
  let m: RegExpMatchArray | null;
  if ((m = name.match(/^(addTo|add)([A-Z].*)$/))) return { mode: 'contains', stem: m[2] };
  if ((m = name.match(/^(removeFrom|remove)([A-Z].*)$/))) return { mode: 'notContains', stem: m[2] };
  if ((m = name.match(/^(set|update|configure)([A-Z].*)$/))) return { mode: 'equal', stem: m[2] };
  if ((m = name.match(/^(create|register|initOrUpgrade|init)([A-Z].*)$/))) return { mode: 'fields', stem: m[2] };
  return null;
}

/** Which setter inputs feed the getter inputs: by name first, then a positional prefix by type. */
function splitKeys(setter: viem.AbiFunction, getter: viem.AbiFunction): number[] | null {
  const si = setter.inputs;
  const gi = getter.inputs;
  if (gi.length > si.length) return null;
  const byName = gi.map((g) => si.findIndex((s) => s.name && s.name === g.name && typeKey(s) === typeKey(g)));
  if (byName.every((i) => i >= 0) && new Set(byName).size === byName.length) return byName;
  if (gi.every((g, i) => typeKey(g) === typeKey(si[i]))) return gi.map((_g, i) => i);
  return null;
}

/**
 * Finds the view function that reads back what a setter wrote, by naming and typing conventions only.
 * Returns null when no getter fits.
 */
export function deriveCheck(setter: viem.AbiFunction, abi: viem.Abi): Check | null {
  const views = abi.filter(isView);
  const byName = (n: string) => views.filter((v) => v.name === n);

  if (setter.name === 'upgradeTo' && setter.inputs.length === 1) {
    const g = byName('getImplementation').find((v) => !v.inputs.length);
    if (g) return { getter: g, keyIdx: [], valueIdx: [0], compare: 'outputs', rule: 'builtin:upgradeTo' };
  }
  if (setter.name === 'nominateNewOwner') {
    const g = byName('owner').find((v) => !v.inputs.length);
    if (g) {
      const alt = byName('nominatedOwner')[0];
      return {
        getter: g,
        keyIdx: [],
        valueIdx: [0],
        compare: 'ownerOrNominated',
        rule: 'builtin:nominateNewOwner',
        ...(alt ? { alt } : {}),
      };
    }
  }

  const st = stemOf(setter.name);
  if (!st) return null;
  const { mode, stem } = st;
  const names = [
    'get' + stem,
    lcfirst(stem),
    'is' + stem,
    'get' + stem + 's',
    'get' + stem + 'Configuration',
    'get' + stem + 'Full',
    'getRegistered' + stem,
  ];

  for (const n of names) {
    for (const g of byName(n)) {
      const keyIdx = splitKeys(setter, g);
      if (keyIdx) {
        const valueIdx = setter.inputs.map((_x, i) => i).filter((i) => !keyIdx.includes(i));
        const V = valueIdx.map((i) => setter.inputs[i]);
        const O = g.outputs || [];
        if (mode === 'contains' || mode === 'notContains') {
          if (V.length === 1 && O.length === 1 && O[0].type === V[0].type + '[]') {
            return { getter: g, keyIdx, valueIdx, compare: mode, rule: 'auto:' + mode };
          }
          continue;
        }
        const plain = (compare: Plain['compare'], rule: string, idx = valueIdx): Check => ({
          getter: g,
          keyIdx,
          valueIdx: idx,
          compare,
          rule,
        });
        if (V.length && O.length === V.length) {
          // outputs to values by name if possible, else positionally by type
          const nameMap = O.map((o) => V.findIndex((v) => v.name && o.name && stripName(v.name) === stripName(o.name)));
          if (
            nameMap.every((i) => i >= 0) &&
            new Set(nameMap).size === O.length &&
            O.every((o, j) => typeKey(o) === typeKey(V[nameMap[j]]))
          ) {
            return plain(
              'outputs',
              'auto:equal/name',
              nameMap.map((i) => valueIdx[i])
            );
          }
          if (sameTypes(O, V)) return plain('outputs', V.length === 1 ? 'auto:equal/1' : 'auto:equal/pos');
        }
        if (O.length && O.length < V.length) {
          // getter returns a named subset of the written values
          const sub = O.map((o) =>
            V.findIndex((v) => v.name && o.name && stripName(v.name) === stripName(o.name) && typeKey(v) === typeKey(o))
          );
          if (sub.every((i) => i >= 0) && new Set(sub).size === O.length) {
            return plain(
              'outputs',
              'auto:equal/subset',
              sub.map((i) => valueIdx[i])
            );
          }
        }
        const oc = (O[0] as { components?: readonly Param[] } | undefined)?.components;
        if (V.length && O.length === 1 && O[0].type === 'tuple' && oc && sameTypes(oc, V)) {
          return plain('tupleOut', 'auto:equal/tupleOut');
        }
        const vc = (V[0] as { components?: readonly Param[] } | undefined)?.components;
        if (V.length === 1 && V[0].type === 'tuple' && vc && O.length === vc.length && sameTypes(O, vc)) {
          return plain('tupleIn', 'auto:equal/tupleIn');
        }
      }

      // struct setter whose keys live inside the struct: configureX(Struct) -> getXConfiguration(key) returns Struct
      if (mode === 'equal' && setter.inputs.length === 1 && setter.inputs[0].type === 'tuple') {
        const S = setter.inputs[0] as Param & { components: readonly Param[] };
        const O = g.outputs || [];
        if (O.length === 1 && typeKey(O[0]) === typeKey(S)) {
          const keyFields = g.inputs.map((gi) => {
            const byN = S.components.findIndex((c) => c.name === gi.name && c.type === gi.type);
            if (byN >= 0) return byN;
            const same = S.components.map((c, i) => (c.type === gi.type ? i : -1)).filter((i) => i >= 0);
            return same.length === 1 ? same[0] : -1;
          });
          if (keyFields.every((i) => i >= 0)) {
            return { getter: g, keyFields, compare: 'structKeyed', rule: 'auto:equal/structKeyed' };
          }
        }
      }
    }
  }

  // field getters: createPool(id, owner) -> getPoolOwner(id); one partial check per value field
  const fields: Check[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < setter.inputs.length; i++) {
    const v = setter.inputs[i];
    if (!v.name) continue;
    const cands = ['get' + stem + ucfirst(stripName(v.name)), 'get' + ucfirst(stripName(v.name))];
    for (const n of cands) {
      for (const g of byName(n)) {
        if ((g.outputs || []).length !== 1 || typeKey(g.outputs[0]) !== typeKey(v)) continue;
        const keyIdx = splitKeys(setter, g);
        if (keyIdx && !keyIdx.includes(i) && !seen.has(g.name)) {
          seen.add(g.name);
          fields.push({ getter: g, keyIdx, valueIdx: [i], compare: 'outputs', rule: 'auto:fields' });
        }
      }
    }
  }
  if (fields.length) return { compare: 'fields', fields, rule: 'auto:fields' };
  return null;
}
