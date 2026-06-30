// Private note management, ported from the frontend `notes.ts`. The IndexedDB specifics become the
// {@link NoteStore} port; the lifecycle logic (revision bumping, legacy normalization, last-write-
// wins recovery merge, on-chain reconciliation) lives here and runs over any store (IndexedDB in
// the browser, SQLite in Node, MemoryStore in tests). Change notification — the frontend's
// `window.dispatchEvent('mosaic-notes-changed')` — is delivered through an injected `onChange`
// callback so the core stays environment-agnostic.

import { nowMs } from "./time.js";
import { ActivityHistory, type ActivityStore } from "./activity.js";
import type { NoteStore } from "./ports.js";
import type { ChainNote, Note, NoteStatus } from "./types.js";

/** Read records written by the previous pending/confirmed/spent status model without requiring a
 * store wipe. Pending/confirmed described indexer readiness, which now lives in the separate
 * `indexed` field; lifecycle status is always active/spent/cancelled. */
export function normalizeNote(raw: Note): Note {
  const legacy = raw as unknown as Omit<Note, "status" | "indexed"> & {
    status: NoteStatus | "pending" | "confirmed";
    indexed?: boolean;
  };
  const status: NoteStatus = legacy.cancelledAt
    ? "cancelled"
    : legacy.status === "spent"
      ? "spent"
      : legacy.status === "cancelled"
        ? "cancelled"
        : "active";
  const indexed = legacy.indexed ?? legacy.status === "confirmed";
  return {
    ...legacy,
    status,
    indexed,
    recovery_state: legacy.recovery_state ?? (legacy.wallet_address ? "protected" : "local-only"),
    revision: legacy.revision ?? 0,
  };
}

/** Last-write-wins merge of two snapshots of the same note, with monotonic lifecycle/indexed. */
export function mergeNote(a: Note, b: Note): Note {
  const ar = a.revision ?? 0;
  const br = b.revision ?? 0;
  const newer =
    br > ar || (br === ar && (b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt)) ? b : a;
  const other = newer === a ? b : a;
  const terminal = [a, b].find((n) => n.status === "spent" || n.status === "cancelled");
  return {
    ...other,
    ...newer,
    status: terminal?.status ?? newer.status,
    indexed: a.indexed || b.indexed,
    recovery_state: "protected",
    revision: Math.max(ar, br),
    updatedAt: Math.max(a.updatedAt ?? a.createdAt, b.updatedAt ?? b.createdAt),
  };
}

/** Manage the wallet's private notes over a {@link NoteStore}. */
export class NoteManager {
  private readonly store: NoteStore;
  private readonly onChange?: () => void;
  private readonly activity: ActivityHistory;

  constructor(store: NoteStore, onChange?: () => void, activity?: ActivityStore) {
    this.store = store;
    this.onChange = onChange;
    this.activity = new ActivityHistory(activity);
  }

  private notify(): void {
    this.onChange?.();
  }

  /** Insert or replace a note, defaulting revision/updatedAt. */
  async add(n: Note): Promise<void> {
    await this.store.put({ ...n, revision: n.revision ?? 1, updatedAt: n.updatedAt ?? n.createdAt });
    this.notify();
  }

  /** Notes for a desk (newest first), scoped to a wallet when given. */
  async forDesk(deskId: string, walletAddress?: string | null): Promise<Note[]> {
    const all = (await this.store.byDesk(deskId)).map(normalizeNote);
    return all
      .filter((n) => !n.wallet_address || n.wallet_address === walletAddress)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Patch a note, incrementing its revision and stamping updatedAt. */
  async update(id: string, patch: Partial<Note>): Promise<void> {
    const cur = await this.store.get(id);
    if (!cur) return;
    const note = normalizeNote(cur);
    await this.store.put({
      ...note,
      ...patch,
      revision: (note.revision ?? 0) + 1,
      updatedAt: nowMs(),
    });
    this.notify();
  }

  async remove(id: string): Promise<void> {
    await this.store.delete(id);
    this.notify();
  }

  /** Account-scoped, recovery-enabled notes. */
  async recoveryNotes(walletAddress: string): Promise<Note[]> {
    const all = (await this.store.all()).map(normalizeNote);
    return all.filter((n) => n.wallet_address === walletAddress && n.recovery_version === 1);
  }

  /** Mark all of a wallet's recovery notes as protected (synced). */
  async markRecoveryProtected(walletAddress: string): Promise<void> {
    const all = (await this.store.all()).map(normalizeNote);
    let changed = false;
    for (const n of all) {
      if (
        n.wallet_address === walletAddress &&
        n.recovery_version === 1 &&
        n.recovery_state !== "protected"
      ) {
        await this.store.put({ ...n, recovery_state: "protected" });
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** Merge a decrypted backup snapshot into the store. Legacy records (no wallet_address) untouched. */
  async mergeRecoveryNotes(walletAddress: string, incoming: Note[]): Promise<void> {
    for (const raw of incoming) {
      if (raw.wallet_address !== walletAddress || raw.recovery_version !== 1) continue;
      const remote = normalizeNote({ ...raw, recovery_state: "protected" });
      const currentRaw = await this.store.get(remote.id);
      if (!currentRaw) {
        await this.store.put(remote);
        continue;
      }
      const current = normalizeNote(currentRaw);
      if (current.wallet_address && current.wallet_address !== walletAddress) continue;
      await this.store.put(mergeNote(current, remote));
    }
    this.notify();
  }

  /**
   * Reconcile local notes against the on-chain note set (matched by owner_tag): stamp leaf_index,
   * mark indexed, and replace an estimated output amount with its real on-chain amount. Returns true
   * if anything changed.
   */
  async reconcile(deskId: string, chain: ChainNote[]): Promise<boolean> {
    const byTag = new Map(chain.map((c) => [c.owner_tag.toLowerCase(), c]));
    const local = (await this.store.byDesk(deskId)).map(normalizeNote);
    let changed = false;
    for (const n of local) {
      if (n.status === "cancelled") continue; // cancelled order: no fill will arrive
      const c = byTag.get(n.owner_tag.toLowerCase());
      if (!c) continue;
      const patch: Partial<Note> = {};
      if (n.leaf_index !== c.leaf_index) patch.leaf_index = c.leaf_index;
      if (!n.indexed) {
        patch.indexed = true;
        patch.amount = c.amount;
      }
      if (Object.keys(patch).length) {
        await this.update(n.id, patch);
        if (!n.indexed && patch.indexed) {
          await this.activity.record({
            kind: "note_indexed",
            idempotency_key: `note-indexed:${deskId}:${n.id}:${c.leaf_index}`,
            status: "indexed",
            desk_id: deskId,
            note_id: n.id,
            owner_tag: n.owner_tag,
            tx_hash: n.txHash,
            metadata: {
              role: n.role,
              asset_id: c.asset,
              amount: c.amount,
              leaf_index: c.leaf_index,
              symbol: n.symbol,
            },
          }).catch(() => undefined);
        }
        changed = true;
      }
    }
    return changed;
  }
}
