/** Parse a non-negative numeric env var, falling back when unset, empty, non-finite, or negative.
 *
 * One parser for every `MOSAIC_MCP_*` numeric knob so the semantics can't drift between call sites
 * (they previously did: some accepted `0`, some rejected it). By default `0` is rejected (a zero
 * timeout/size is almost always a mistake); pass `allowZero` where `0` is a meaningful sentinel that
 * disables the feature (e.g. tool timeout, max body size). */
export function envNumber(name: string, fallback: number, opts: { allowZero?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0 && !opts.allowZero) return fallback;
  return parsed;
}
