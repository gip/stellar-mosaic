import { useActivity } from '../ActivityContext'
import ActivityGroupList from '../components/ActivityGroupList'
import { activityGroups } from '../components/activityModel'

export default function ActivityPage() {
  const { operations, activities } = useActivity()
  const groups = activityGroups(activities, operations)
  return (
    <div className="reading activity-page">
      <h2>Activity</h2>
      <p className="muted">
        Transaction history, wallet operations, contract events, fills, indexed notes, and errors for the current data mode.
      </p>
      <ActivityGroupList groups={groups} empty="No activity has been recorded for this mode yet." />
    </div>
  )
}
