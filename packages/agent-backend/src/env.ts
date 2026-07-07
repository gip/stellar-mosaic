/** Parse a non-negative numeric env var, falling back when unset, empty, non-finite, or negative.
 * Copies packages/mcp/src/env.ts so every MOSAIC_AGENT_* numeric knob shares one semantics. By
 * default `0` is rejected; pass `allowZero` where `0` is a meaningful "disable" sentinel. */
export function envNumber(name: string, fallback: number, opts: { allowZero?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0 && !opts.allowZero) return fallback;
  return parsed;
}
