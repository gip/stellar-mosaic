import type { ActivityEvent } from '@mosaic/sdk'
import { browserActivityStore } from './sdk/indexedDbStore'
import type { StorageMode } from './StorageModeContext'

/** A grouping id shared by every event of a single desk deployment, matching the `action_id`
 * convention the SDK's `client.deploy` uses in trustless mode. Threading one id through the desk
 * creation and its Base-bridge steps folds them into a single Activity group. */
export function newActionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Record a public-safe activity event to the browser store for `mode`, for browser-signed actions
 * that bypass the SDK client (deploys, Base-bridge allowlist adds). Best-effort: an on-chain action
 * must never fail because activity logging did (the on-chain state is authoritative). Uses the same
 * action names the SDK emits (`create_desk` / `deploy_base_bridge` / `add_allowed` / …), so both
 * modes group and label identically in the Activity tab. */
export async function recordDeployActivity(mode: StorageMode, event: ActivityEvent): Promise<void> {
  try {
    await browserActivityStore(mode).record(event)
  } catch {
    /* Activity is best-effort UI state; the deploy itself is authoritative. */
  }
}
