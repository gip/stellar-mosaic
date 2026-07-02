import {
  type ActivityGroup,
  formatStatus,
  short,
  statusTone,
  stellarAddressUrl,
  txNetworkLabel,
  txUrl,
} from './activityModel'

export default function ActivityGroupList({
  groups,
  empty = 'No recorded activity yet.',
}: {
  groups: ActivityGroup[]
  empty?: string
}) {
  if (groups.length === 0) return <p className="activity-empty">{empty}</p>
  return (
    <div className="activity-groups">
      {groups.map((group, groupIndex) => (
        <section className="activity-group" key={`${group.id}:${groupIndex}`}>
          <div className="activity-row">
            <div className="activity-summary-main">
              <div className="activity-summary-heading">
                <h4>{group.action}</h4>
                {group.createdAt && <time dateTime={new Date(group.createdAt).toISOString()} title={absoluteTime(group.createdAt)}>{timeAgo(group.createdAt)}</time>}
                <span className={`activity-status-mark ${statusTone(group.status)}`} title={group.error ? `${formatStatus(group.status)}: ${group.error}` : formatStatus(group.status)} aria-label={formatStatus(group.status)}>{statusMark(group.status)}</span>
              </div>
              <span className="activity-summary-text" title={group.summary}>{renderLinkedSummary(group.summary)}</span>
              {group.error && <span className="activity-summary-error" title={group.error}>{group.error}</span>}
            </div>
            <div className="activity-tx-list">
              {group.lines.flatMap((line, lineIndex) => {
                if (!line.tx || !line.activity) return []
                const network = txNetworkLabel(line.tx, line.activity)
                return (
                  <div className="activity-tx-line" key={`${group.id}:${line.id}:${lineIndex}`}>
                    <a className="mono activity-tx-link" href={txUrl(line.tx, line.activity)} target="_blank" rel="noreferrer" title={`${line.description} (${network}): ${line.tx}`}>
                      {short(line.tx)}
                    </a>
                    <span className="activity-tx-desc">{line.description} ({network})</span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}

function statusMark(status?: string) {
  const tone = statusTone(status)
  if (tone === 'ok') return '✓'
  if (tone === 'err') return '✕'
  if (tone === 'busy') return '⧗'
  return '•'
}

function renderLinkedSummary(value: string) {
  const parts = value.split(/([GCM][A-Z2-7]{55})/g)
  return parts.map((part, index) => {
    if (!/^[GCM][A-Z2-7]{55}$/.test(part)) return part
    return <a className="mono activity-address-link" href={stellarAddressUrl(part)} target="_blank" rel="noreferrer" title={part} key={`${part}-${index}`}>{short(part)}</a>
  })
}

function absoluteTime(value: number) {
  return new Date(value).toLocaleString()
}

function timeAgo(value: number) {
  const delta = Math.max(0, Date.now() - value)
  if (delta < 30_000) return 'just now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}
