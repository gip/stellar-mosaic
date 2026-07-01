import type { ReactNode } from 'react'

/** Horizontal-scroll wrapper so wide data tables don't overflow on narrow viewports. */
export default function ScrollTable({ children }: { children: ReactNode }) {
  return <div className="scroll-table">{children}</div>
}
