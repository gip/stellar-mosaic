import initACVM from '@noir-lang/acvm_js'
import initAbi from '@noir-lang/noirc_abi'

let initPromise: Promise<void> | null = null

function publicAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`
}

export function initNoirWasm(): Promise<void> {
  initPromise ??= Promise.all([
    initAbi({ module_or_path: publicAsset('noir-wasm/noirc_abi_wasm_bg.wasm') }),
    initACVM({ module_or_path: publicAsset('noir-wasm/acvm_js_bg.wasm') }),
  ]).then(() => undefined)
  return initPromise
}
