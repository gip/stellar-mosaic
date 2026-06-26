// In-browser Noir "wallet math" execution — now delegated to @mosaic/sdk's makeWalletMath, fed by
// the browser circuit provider (fetches /circuits/*.json, exactly as before). Re-exported under the
// same names so existing imports of './noir' keep working.
import { makeWalletMath } from '@mosaic/sdk'
import { circuitProvider } from '@mosaic/sdk/assets/browser'
import { initNoirWasm } from './noirWasm'

export type { OrderTerms, JoinTerms } from '@mosaic/sdk'

const wallet = makeWalletMath(circuitProvider, { initNoir: initNoirWasm })

export const { noteTag, orderTerms, noteNullifier, joinTerms } = wallet
