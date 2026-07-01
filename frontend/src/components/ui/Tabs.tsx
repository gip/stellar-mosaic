import type { ReactNode } from 'react'

export type TabDef = {
  id: string
  label: ReactNode
  disabled?: boolean
}

/** Controlled underline tab strip with the WAI-ARIA tablist pattern. The caller renders the
 * active panel; pass `panelId`/`children` to wrap it in a labelled tabpanel. */
export default function Tabs({
  tabs,
  value,
  onChange,
  ariaLabel,
  panelId,
  children,
}: {
  tabs: TabDef[]
  value: string
  onChange: (id: string) => void
  ariaLabel: string
  panelId?: string
  children?: ReactNode
}) {
  const activeTab = tabs.find((t) => t.id === value)?.id ?? tabs[0]?.id
  return (
    <>
      <div className="tabs" role="tablist" aria-label={ariaLabel}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${t.id}-tab`}
            className={`tab${t.id === activeTab ? ' active' : ''}`}
            aria-selected={t.id === activeTab}
            aria-controls={panelId}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {children !== undefined && (
        <div id={panelId} role="tabpanel" aria-labelledby={`${activeTab}-tab`} className="tab-panel">
          {children}
        </div>
      )}
    </>
  )
}
