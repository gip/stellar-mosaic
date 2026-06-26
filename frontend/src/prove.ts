// In-browser UltraHonk proving — now delegated to @mosaic/sdk's makeProver, fed by the browser
// circuit provider (fetches /circuits/*.json). Re-exported under the same names so existing imports
// of './prove' keep working.
import { makeProver } from '@mosaic/sdk'
import { circuitProvider } from '@mosaic/sdk/assets/browser'

export { b64 } from '@mosaic/sdk'
export type { LiftInputs, UnshieldInputs, JoinInputs, CancelInputs, ProofBundle } from '@mosaic/sdk'

const prover = makeProver(circuitProvider)

export const { proveLift, proveUnshield, proveJoin, proveCancel } = prover
