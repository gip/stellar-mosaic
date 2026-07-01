import StatusDot from './ui/StatusDot'
import {
  type ActivityGroup,
  formatStatus,
  short,
  statusTone,
  stellarAddressUrl,
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
      {groups.map((group) => (
        <section className="activity-group" key={group.id}>
          <div className="activity-summary">
            <div className="activity-summary-main">
              <div className="activity-summary-heading">
                <h4>{group.action}</h4>
                {group.createdAt && <time dateTime={new Date(group.createdAt).toISOString()} title={absoluteTime(group.createdAt)}>{timeAgo(group.createdAt)}</time>}
              </div>
              <span className="activity-summary-text" title={group.summary}>{renderLinkedSummary(group.summary)}</span>
            </div>
            <StatusDot tone={statusTone(group.status)} title={formatStatus(group.status)}>
              <span className="activity-status-label">{formatStatus(group.status)}</span>
            </StatusDot>
          </div>
          {group.lines.map((line) => (
            <div className="activity-line" key={line.id}>
              <span className="activity-line-label">{line.label}</span>
              {line.tx && line.activity
                ? <a className="mono activity-tx-link" href={txUrl(line.tx, line.activity)} target="_blank" rel="noreferrer" title={line.tx}>{short(line.tx)}</a>
                : <span className="muted">No tx</span>}
              <StatusDot tone={statusTone(line.status)} title={formatStatus(line.status)}>
                <span className="activity-status-label">{formatStatus(line.status)}</span>
              </StatusDot>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
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
