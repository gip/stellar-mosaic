// Browser StellarSigner adapter for @mosaic/sdk, backed by the Freighter extension. Used by the
// local-mode client (createBrowserClient); the signer holds the connected address and delegates to
// Freighter for transaction / auth-entry signing.
import { signTransaction, signAuthEntry } from '@stellar/freighter-api'
import type { StellarSigner } from '@mosaic/sdk'

function b64(value: string | Uint8Array): string {
  if (typeof value === 'string') return value
  let s = ''
  for (const byte of value) s += String.fromCharCode(byte)
  return btoa(s)
}

export class FreighterSigner implements StellarSigner {
  private readonly addr: string

  constructor(addr: string) {
    this.addr = addr
  }

  async address(): Promise<string> {
    return this.addr
  }

  async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const res = await signTransaction(xdr, { address: this.addr, networkPassphrase: opts.networkPassphrase })
    if (res.error || !res.signedTxXdr) throw new Error(String(res.error ?? 'Freighter returned no signed transaction.'))
    return res.signedTxXdr
  }

  async signAuthEntry(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const res = await signAuthEntry(xdr, { address: this.addr, networkPassphrase: opts.networkPassphrase })
    if (res.error || !res.signedAuthEntry) throw new Error(String(res.error ?? 'Freighter returned no signature.'))
    return b64(res.signedAuthEntry as string | Uint8Array)
  }

  async signMessage(): Promise<Uint8Array> {
    // Recovery/auth message signing stays on the existing wallet.ts path; not needed by the
    // local-mode client. Implement here if/when recovery moves onto the SDK.
    throw new Error('FreighterSigner.signMessage is not used by the local client.')
  }
}
