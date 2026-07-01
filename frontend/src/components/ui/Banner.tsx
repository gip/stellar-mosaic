import type { ReactNode } from 'react'

export type BannerTone = 'err' | 'warn' | 'info'

export default function Banner({
  tone,
  children,
  role,
  className = '',
}: {
  tone: BannerTone
  children: ReactNode
  role?: 'alert' | 'status'
  className?: string
}) {
  return (
    <div className={`banner ${tone} ${className}`.trim()} role={role ?? (tone === 'err' ? 'alert' : 'status')}>
      <div className="banner-body">{children}</div>
    </div>
  )
}
