import { useEffect } from 'react'

export interface ToastItem {
  id: string
  text: string
}

/** A fixed, bottom-right stack of transient notifications. Each toast auto-dismisses after a few
 * seconds (or on click). `onDismiss` must be stable (memoize it) so the per-toast timer isn't reset
 * on every parent render. */
export default function Toasts({
  items,
  onDismiss,
}: {
  items: ToastItem[]
  onDismiss: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="toasts">
      {items.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const h = setTimeout(() => onDismiss(item.id), 9000)
    return () => clearTimeout(h)
  }, [item.id, onDismiss])
  return (
    <div className="toast ok" role="status" onClick={() => onDismiss(item.id)}>
      {item.text}
    </div>
  )
}
