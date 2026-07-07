/** `fetch()` with an abort-based timeout. Returns the raw Response (does not check `res.ok`) and
 * lets the underlying fetch/abort error propagate — callers layer their own error typing, body
 * handling, and timeout source on top. One copy of the AbortController/timer dance so the readiness
 * probes and the base-shield worker can't drift in how they cancel a slow request. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
