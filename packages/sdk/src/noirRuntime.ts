export interface NoirRuntimeOptions {
  /**
   * Browser bundlers sometimes need to initialize Noir's WASM modules from app-served URLs before
   * `new Noir(...)` runs. Node callers can leave this unset.
   */
  initNoir?: () => Promise<void>;
}

export async function initNoirRuntime(opts?: NoirRuntimeOptions): Promise<void> {
  await opts?.initNoir?.();
}
