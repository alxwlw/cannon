// the builder still accepts these legacy action names; rows and pending changes carry the current name
const KIND_ALIASES: Record<string, string> = { contract: 'deploy', provision: 'clone', import: 'pull' };

/** The action kind of a step name (`invoke.setThing` → `invoke`), legacy names mapped to their current one. */
export function kindOf(step: string): string {
  const raw = step.split('.')[0];
  return Object.prototype.hasOwnProperty.call(KIND_ALIASES, raw) ? KIND_ALIASES[raw] : raw;
}
