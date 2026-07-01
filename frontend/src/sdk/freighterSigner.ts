// Browser StellarSigner adapter for @mosaic/sdk, backed by the Freighter extension. Used by the
// local-mode client (createBrowserClient); the signer holds the connected address and delegates to
// Freighter for transaction / auth-entry signing.
import { signTransaction, signAuthEntry, signMessage } from '@stellar/freighter-api'
import { errorMessage, type StellarSigner } from '@mosaic/sdk'

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
    if (res.error || !res.signedTxXdr) throw new Error(res.error ? errorMessage(res.error) : 'Freighter returned no signed transaction.')
    return res.signedTxXdr
  }

  async signAuthEntry(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const res = await signAuthEntry(xdr, { address: this.addr, networkPassphrase: opts.networkPassphrase })
    if (res.error || !res.signedAuthEntry) throw new Error(res.error ? errorMessage(res.error) : 'Freighter returned no signature.')
    return b64(res.signedAuthEntry as string | Uint8Array)
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const text = new TextDecoder().decode(message)
    const res = await signMessage(text, { address: this.addr })
    if (res.error || !res.signedMessage) throw new Error(res.error ? errorMessage(res.error) : 'Freighter returned no signed message.')
    return typeof res.signedMessage === 'string'
      ? Uint8Array.from(atob(res.signedMessage), (c) => c.charCodeAt(0))
      : res.signedMessage
  }
}
