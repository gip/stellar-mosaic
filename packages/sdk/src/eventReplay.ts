import { NoteTree, type Compressor } from "./noteTree.js";
import type { NoteSource } from "./ports.js";
import type { ChainNote, Field, Fill, NoteProof, TreeEvent } from "./types.js";
import { getMosaicLogger, type MosaicLogger } from "./logging.js";

export type EventSource = (deskId: string) => Promise<TreeEvent[]>;
export type FillSource = (deskId: string) => Promise<Fill[]>;

export interface ReplayedNoteState {
  event_count: number;
  events: TreeEvent[];
  tree: NoteTree;
  root: Field;
  notes: ChainNote[];
  fills: Fill[];
}

interface DeskCache {
  count: number;
  state: ReplayedNoteState;
}

export async function rebuildNoteTree(events: TreeEvent[], compress: Compressor): Promise<NoteTree> {
  const tree = new NoteTree(compress);
  for (const ev of events) await tree.ingest(ev);
  return tree;
}

export async function replayNoteEvents(opts: {
  events: TreeEvent[];
  fills?: Fill[];
  compress: Compressor;
}): Promise<ReplayedNoteState> {
  const tree = await rebuildNoteTree(opts.events, opts.compress);
  const [root, notes] = await Promise.all([tree.root(), Promise.resolve(tree.notes())]);
  return {
    event_count: opts.events.length,
    events: opts.events,
    tree,
    root,
    notes,
    fills: opts.fills ?? [],
  };
}

/** Shared event replay service: fetch insertion-ordered tree events, rebuild the note tree, and
 * expose the same NoteSource surface plus a full replay snapshot. */
export class NoteEventReplayer implements NoteSource {
  private readonly compress: Compressor;
  private readonly source: EventSource;
  private readonly fillSource?: FillSource;
  private readonly cache = new Map<string, DeskCache>();
  private readonly logger: MosaicLogger;

  constructor(opts: { compress: Compressor; events: EventSource; fills?: FillSource; logger?: MosaicLogger }) {
    this.compress = opts.compress;
    this.source = opts.events;
    this.fillSource = opts.fills;
    this.logger = opts.logger ?? getMosaicLogger();
  }

  async replay(deskId: string): Promise<ReplayedNoteState> {
    try {
      const events = await this.source(deskId);
      const cached = this.cache.get(deskId);
      if (cached && cached.count === events.length) {
        this.logger.debug("note replay cache hit", { deskId, eventCount: events.length });
        return cached.state;
      }
      const fills = this.fillSource ? await this.fillSource(deskId) : [];
      const state = await replayNoteEvents({ events, fills, compress: this.compress });
      this.cache.set(deskId, { count: events.length, state });
      this.logger.info("note replay rebuilt", {
        deskId,
        eventCount: events.length,
        noteCount: state.notes.length,
        fillCount: fills.length,
        root: state.root,
      });
      return state;
    } catch (error) {
      this.logger.error("note replay failed", { deskId, error });
      throw error;
    }
  }

  async root(deskId: string): Promise<Field> {
    return (await this.replay(deskId)).root;
  }

  async notes(deskId: string): Promise<ChainNote[]> {
    return (await this.replay(deskId)).notes;
  }

  async notePath(deskId: string, ownerTag: Field): Promise<NoteProof> {
    const state = await this.replay(deskId);
    const idx = state.tree.indexOfOwnerTag(ownerTag);
    if (idx < 0) throw new Error(`no note with owner_tag ${ownerTag} in desk ${deskId}`);
    return state.tree.noteProofAt(idx);
  }

  async events(deskId: string): Promise<TreeEvent[]> {
    return (await this.replay(deskId)).events;
  }

  async fills(deskId: string): Promise<Fill[]> {
    return (await this.replay(deskId)).fills;
  }
}
