import type { Compressor } from "./noteTree.js";
import type { NoteSource } from "./ports.js";
import type { ChainNote, Field, Fill, NoteProof, TreeEvent } from "./types.js";
import {
  NoteEventReplayer,
  type EventSource,
  type FillSource,
  type ReplayedNoteState,
} from "./eventReplay.js";
import type { MosaicLogger } from "./logging.js";

export class LocalPathProvider implements NoteSource {
  private readonly replayer: NoteEventReplayer;

  constructor(opts: { compress: Compressor; events: EventSource; fills?: FillSource; logger?: MosaicLogger }) {
    this.replayer = new NoteEventReplayer(opts);
  }

  async root(deskId: string): Promise<Field> {
    return this.replayer.root(deskId);
  }

  async notes(deskId: string): Promise<ChainNote[]> {
    return this.replayer.notes(deskId);
  }

  async notePath(deskId: string, ownerTag: Field): Promise<NoteProof> {
    return this.replayer.notePath(deskId, ownerTag);
  }

  async events(deskId: string): Promise<TreeEvent[]> {
    return this.replayer.events(deskId);
  }

  async fills(deskId: string): Promise<Fill[]> {
    return this.replayer.fills(deskId);
  }

  async replay(deskId: string): Promise<ReplayedNoteState> {
    return this.replayer.replay(deskId);
  }
}
