import { DocumentIdentity, EditBurstData } from './types';

export interface EditChangeSample {
  insertedChars: number;
  deletedChars: number;
  insertedNewlines: number;
  deletedNewlines: number;
}

export interface FlushedEditBurst {
  docKey: string;
  identity: DocumentIdentity;
  languageId: string | null;
  data: EditBurstData;
}

interface PendingBurst {
  docKey: string;
  identity: DocumentIdentity;
  languageId: string | null;
  changeEvents: number;
  charsInserted: number;
  charsDeleted: number;
  linesAdded: number;
  linesRemoved: number;
  undoEvents: number;
  redoEvents: number;
  firstMonoMs: number;
  lastMonoMs: number;
  lineCount: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Aggregates document edits into debounced summary bursts so telemetry records
 * coding activity volume without logging source text or keystroke timings.
 */
export class EditAccumulator {
  private readonly pending = new Map<string, PendingBurst>();
  private windowMs: number;

  constructor(
    windowMs: number,
    private readonly onFlush: (burst: FlushedEditBurst) => void
  ) {
    this.windowMs = windowMs;
  }

  setWindowMs(windowMs: number): void {
    this.windowMs = Math.max(500, windowMs);
  }

  record(
    docKey: string,
    identity: DocumentIdentity,
    languageId: string | null,
    changes: readonly EditChangeSample[],
    lineCount: number,
    monoMs: number,
    reason?: 'undo' | 'redo'
  ): void {
    if (changes.length === 0) {
      return;
    }

    let charsInserted = 0;
    let charsDeleted = 0;
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const c of changes) {
      charsInserted += c.insertedChars;
      charsDeleted += c.deletedChars;
      linesAdded += c.insertedNewlines;
      linesRemoved += c.deletedNewlines;
    }

    const existing = this.pending.get(docKey);
    if (existing) {
      clearTimeout(existing.timer);
      existing.identity = identity;
      existing.languageId = languageId;
      existing.changeEvents += 1;
      existing.charsInserted += charsInserted;
      existing.charsDeleted += charsDeleted;
      existing.linesAdded += linesAdded;
      existing.linesRemoved += linesRemoved;
      existing.undoEvents += reason === 'undo' ? 1 : 0;
      existing.redoEvents += reason === 'redo' ? 1 : 0;
      existing.lastMonoMs = monoMs;
      existing.lineCount = lineCount;
      existing.timer = setTimeout(() => this.flushDocument(docKey), this.windowMs);
      return;
    }

    const timer = setTimeout(() => this.flushDocument(docKey), this.windowMs);
    this.pending.set(docKey, {
      docKey,
      identity,
      languageId,
      changeEvents: 1,
      charsInserted,
      charsDeleted,
      linesAdded,
      linesRemoved,
      undoEvents: reason === 'undo' ? 1 : 0,
      redoEvents: reason === 'redo' ? 1 : 0,
      firstMonoMs: monoMs,
      lastMonoMs: monoMs,
      lineCount,
      timer,
    });
  }

  flushDocument(docKey: string): void {
    const entry = this.pending.get(docKey);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(docKey);

    this.onFlush({
      docKey: entry.docKey,
      identity: entry.identity,
      languageId: entry.languageId,
      data: {
        changeEvents: entry.changeEvents,
        charsInserted: entry.charsInserted,
        charsDeleted: entry.charsDeleted,
        linesAdded: entry.linesAdded,
        linesRemoved: entry.linesRemoved,
        undoEvents: entry.undoEvents,
        redoEvents: entry.redoEvents,
        durationMs: Math.max(0, Math.round(entry.lastMonoMs - entry.firstMonoMs)),
        lineCount: entry.lineCount,
      },
    });
  }

  flushAll(): void {
    for (const key of Array.from(this.pending.keys())) {
      this.flushDocument(key);
    }
  }

  dispose(): void {
    this.flushAll();
  }
}
