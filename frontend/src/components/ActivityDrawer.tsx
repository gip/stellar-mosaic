import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useActivity } from '../ActivityContext'
import ActivityGroupList from './ActivityGroupList'
import { activityGroups, terminalStatus } from './activityModel'

export default function ActivityDrawer() {
  const { operations, activities } = useActivity()
  const [open, setOpen] = useState(false)
  const groups = activityGroups(activities, operations)
  const recentGroups = groups.slice(0, 8)
  const activeCount = groups.filter((group) => !terminalStatus(group.status)).length
  return (
    <aside className={`activity-drawer${open ? ' open' : ''}`}>
      {open && (
        <div className="activity-panel">
          <div className="activity-panel-header">
            <h3>Activity</h3>
            <Link to="/activity" onClick={() => setOpen(false)}>View all</Link>
          </div>
          <ActivityGroupList groups={recentGroups} />
        </div>
      )}
      <button type="button" className="activity-toggle" onClick={() => setOpen((value) => !value)}>
        Activity{activeCount ? ` (${activeCount})` : ''}
      </button>
    </aside>
  )
}
