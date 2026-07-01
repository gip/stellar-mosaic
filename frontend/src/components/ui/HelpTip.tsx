import { useId, useState, type ReactNode } from 'react'

/** Small "?" affordance that reveals help text on hover/focus. Accessible: the trigger is a
 * real button that toggles on click and links the popover via aria-describedby. */
export default function HelpTip({ children, label = 'More info' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span
      className="helptip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="helptip-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span className="helptip-pop" id={id} role="tooltip">
          {children}
        </span>
      )}
    </span>
  )
}
