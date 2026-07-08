import type { ReactNode } from 'react'
import { basescanAddressUrl, stellarExpertContractUrl } from '../../explorer'

function explorerFor(address: string): { href: string; site: string } | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { href: basescanAddressUrl(address), site: 'Basescan' }
  }
  if (/^C[A-Z2-7]{55}$/.test(address)) {
    return { href: stellarExpertContractUrl(address), site: 'Stellar Expert' }
  }
  return null
}

/** Renders a contract address as a link to its chain explorer — Basescan for 0x… addresses,
 * Stellar Expert for C… contract ids. Values that are neither render as plain text. */
export default function ExplorerLink({
  address,
  className,
  children,
}: {
  address: string
  className?: string
  children?: ReactNode
}) {
  const explorer = explorerFor(address)
  if (!explorer) return <span className={className}>{children ?? address}</span>
  return (
    <a
      className={className}
      href={explorer.href}
      target="_blank"
      rel="noreferrer"
      title={`View ${address} on ${explorer.site}`}
    >
      {children ?? address}
    </a>
  )
}
