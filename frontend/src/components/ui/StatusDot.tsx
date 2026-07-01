import type { ReactNode } from 'react'

export type StatusTone = 'idle' | 'ok' | 'err' | 'warn' | 'info' | 'accent' | 'busy'

/** A status label conveyed by color *and* text (never color alone), with a small leading dot. */
export default function StatusDot({
  tone = 'idle',
  children,
  title,
}: {
  tone?: StatusTone
  children: ReactNode
  title?: string
}) {
  const cls = tone === 'idle' ? 'status-dot' : `status-dot ${tone}`
  return (
    <span className={cls} title={title} role="status">
      {children}
    </span>
  )
}
