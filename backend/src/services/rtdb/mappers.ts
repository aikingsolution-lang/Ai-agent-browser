/**
 * mappers.ts
 *
 * Conversions shared by the services and the Mongo → RTDB migration script, so data written by
 * either path has exactly the same stored shape.
 */

/** Record<skill, years> → [{ skill, years }] (skill names like "Node.js" or "C#" are not valid RTDB keys). */
export function skillExperienceToList(value: unknown): Array<{ skill: string; years: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([skill, years]) => skill && years !== undefined && years !== null && !Number.isNaN(Number(years)))
    .map(([skill, years]) => ({ skill, years: Number(years) }));
}

/** Record<question, answer> → [{ question, answer }] (questions contain ".", "/", "?", "$", …). */
export function customAnswersToList(value: unknown): Array<{ question: string; answer: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([question, answer]) => question && answer !== undefined && answer !== null)
    .map(([question, answer]) => ({ question, answer: String(answer) }));
}

const ILLEGAL_KEY_CHARS = /[.#$[\]/\u0000-\u001F\u007F]/g;

/**
 * Makes free-form objects (e.g. Mongo `Mixed` metadata) safe to store: characters RTDB forbids in
 * keys are replaced with "_", empty keys are dropped, and undefined/functions are removed.
 * Returns the cleaned value and how many keys had to be renamed.
 */
export function sanitizeForRtdb(value: unknown): { value: unknown; renamedKeys: number } {
  let renamedKeys = 0;
  const visit = (input: unknown): unknown => {
    if (input === undefined || typeof input === 'function') return undefined;
    if (input === null || typeof input !== 'object') {
      return typeof input === 'number' && !Number.isFinite(input) ? null : input;
    }
    if (input instanceof Date) return input.getTime();
    if (typeof (input as any).toHexString === 'function') return (input as any).toHexString();
    if (Array.isArray(input)) return input.map(visit).filter(item => item !== undefined);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      if (!key) {
        renamedKeys++;
        continue;
      }
      const safeKey = key.replace(ILLEGAL_KEY_CHARS, '_');
      if (safeKey !== key) renamedKeys++;
      const cleaned = visit(child);
      if (cleaned !== undefined) out[safeKey] = cleaned;
    }
    return out;
  };
  return { value: visit(value), renamedKeys };
}
