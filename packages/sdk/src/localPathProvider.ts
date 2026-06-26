// LocalPathProvider — the default {@link NoteSource}. Rebuilds the note tree locally (no server)
// from the insertion-ordered chain events and serves root / notes / membership paths. It is given
// a {@link Compressor} (ACVM `compress`) and an `events(deskId)` source (wired to the on-chain
// event reader during the SDK-core extraction / Phase 3).
//
// A small per-desk cache avoids rebuilding the whole tree on every call; it is refreshed when the
// event count grows.

import { NoteTree } from "./noteTree.js";
import type { Compressor } from "./noteTree.js";
import type { NoteSource } from "./ports.js";
import type { ChainNote, Field, NoteProof, TreeEvent } from "./types.js";

/** Reads the insertion-ordered tree events for a desk (shielded / noteins / settled). */
export type EventSource = (deskId: string) => Promise<TreeEvent[]>;

interface DeskCache {
  count: number;
  tree: NoteTree;
}

export class LocalPathProvider implements NoteSource {
  private readonly compress: Compressor;
  private readonly source: EventSource;
  private readonly cache = new Map<string, DeskCache>();

  constructor(opts: { compress: Compressor; events: EventSource }) {
    this.compress = opts.compress;
    this.source = opts.events;
  }

  private async tree(deskId: string): Promise<NoteTree> {
    const events = await this.source(deskId);
    const cached = this.cache.get(deskId);
    // Append-only: if the event count is unchanged, reuse; otherwise rebuild (the memoizing
    // compressor keeps unchanged subtree hashes warm, so a rebuild is cheap).
    if (cached && cached.count === events.length) return cached.tree;
    const tree = new NoteTree(this.compress);
    for (const ev of events) await tree.ingest(ev);
    this.cache.set(deskId, { count: events.length, tree });
    return tree;
  }

  async root(deskId: string): Promise<Field> {
    return (await this.tree(deskId)).root();
  }

  async notes(deskId: string): Promise<ChainNote[]> {
    return (await this.tree(deskId)).notes();
  }

  async notePath(deskId: string, ownerTag: Field): Promise<NoteProof> {
    const tree = await this.tree(deskId);
    const idx = tree.indexOfOwnerTag(ownerTag);
    if (idx < 0) throw new Error(`no note with owner_tag ${ownerTag} in desk ${deskId}`);
    return tree.noteProofAt(idx);
  }

  async events(deskId: string): Promise<TreeEvent[]> {
    return this.source(deskId);
  }
}
