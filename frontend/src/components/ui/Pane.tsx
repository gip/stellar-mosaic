import type { ReactNode } from 'react'

/** A titled panel for the workspace rails. The header row holds the title and optional actions. */
export default function Pane({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`pane ${className}`.trim()}>
      {(title || actions) && (
        <div className="pane-header">
          {title && <h2 className="pane-title">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}
