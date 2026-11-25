import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { EditAccumulator, EditChangeSample } from './editAccumulator';
import { TelemetryHasher } from './hasher';
import { JsonlTelemetryLogger } from './logger';
import { ProjectMatcher } from './projectMatcher';
import {
  DocumentIdentity,
  SCHEMA_VERSION,
  TelemetryEvent,
  TelemetryEventData,
  TelemetryEventType,
} from './types';

const TRACKED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);

const EMPTY_IDENTITY: DocumentIdentity = {
  projectId: null,
  projectSource: 'none',
  fileId: null,
};

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}

export class TelemetryTracker implements vscode.Disposable {
  private readonly sessionId = crypto.randomUUID();
  private readonly sessionStartNs = process.hrtime.bigint();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly docIdentityCache = new Map<string, DocumentIdentity>();
  private readonly editAccumulator: EditAccumulator;

  private activeDocKey: string | null = null;
  private enabled: boolean;

  constructor(
    private readonly hasher: TelemetryHasher,
    private readonly projectMatcher: ProjectMatcher,
    private readonly logger: JsonlTelemetryLogger,
    initialEnabled: boolean,
    editBurstWindowMs: number
  ) {
    this.enabled = initialEnabled;
    this.editAccumulator = new EditAccumulator(editBurstWindowMs, (burst) => {
      this.emit(
        'edit_burst',
        burst.identity,
        burst.languageId,
        burst.data
      );
    });
  }

  start(): void {
    if (this.enabled) {
      this.emit('session_start', EMPTY_IDENTITY, null);
      if (vscode.window.activeTextEditor) {
        void this.handleActiveEditor(vscode.window.activeTextEditor);
      }
    }

    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (!this.enabled) {
          return;
        }
        if (!state.focused) {
          this.editAccumulator.flushAll();
        }
        this.emit('window_focus', EMPTY_IDENTITY, null, {
          focused: state.focused,
        });
      }),

      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (!this.enabled || !this.isTrackedDocument(doc)) {
          return;
        }
        void this.emitDocumentEvent('file_open', doc, {
          lineCount: doc.lineCount,
        });
      }),

      vscode.workspace.onDidCloseTextDocument((doc) => {
        const docKey = doc.uri.toString();
        this.editAccumulator.flushDocument(docKey);
        if (this.enabled && this.isTrackedDocument(doc)) {
          void this.emitDocumentEvent('file_close', doc);
        }
        this.docIdentityCache.delete(docKey);
      }),

      vscode.workspace.onDidSaveTextDocument((doc) => {
        const docKey = doc.uri.toString();
        this.editAccumulator.flushDocument(docKey);
        if (!this.enabled || !this.isTrackedDocument(doc)) {
          return;
        }
        void this.emitDocumentEvent('file_save', doc, {
          lineCount: doc.lineCount,
        });
      }),

      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.activeDocKey) {
          this.editAccumulator.flushDocument(this.activeDocKey);
        }
        if (!this.enabled) {
          this.activeDocKey = editor ? editor.document.uri.toString() : null;
          return;
        }
        void this.handleActiveEditor(editor);
      }),

      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          !this.enabled ||
          event.contentChanges.length === 0 ||
          !this.isTrackedDocument(event.document)
        ) {
          return;
        }
        void this.handleDocumentChange(event);
      }),

      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.clearIdentityCaches();
      })
    );
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    if (!enabled) {
      this.editAccumulator.flushAll();
    }
    this.enabled = enabled;
  }

  setEditBurstWindowMs(windowMs: number): void {
    this.editAccumulator.setWindowMs(windowMs);
  }

  clearIdentityCaches(): void {
    this.docIdentityCache.clear();
    this.projectMatcher.clearCache();
  }

  async shutdown(): Promise<void> {
    this.editAccumulator.flushAll();
    if (this.enabled) {
      this.emit('session_end', EMPTY_IDENTITY, null);
    }
    await this.logger.flush();
  }

  dispose(): void {
    this.editAccumulator.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  private monoMs(): number {
    return Number((process.hrtime.bigint() - this.sessionStartNs) / 1_000_000n);
  }

  private isTrackedDocument(doc: vscode.TextDocument): boolean {
    return TRACKED_SCHEMES.has(doc.uri.scheme);
  }

  private async resolveIdentity(doc: vscode.TextDocument): Promise<DocumentIdentity> {
    const docKey = doc.uri.toString();
    const cached = this.docIdentityCache.get(docKey);
    if (cached) {
      return cached;
    }

    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const workspaceFolderPath =
      folder?.uri.fsPath ??
      (doc.uri.scheme === 'untitled'
        ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
        : null);

    const filePath = doc.uri.scheme === 'file' ? doc.uri.fsPath : null;
    const fallbackKey = doc.uri.scheme === 'file' ? undefined : docKey;

    const identity = await this.projectMatcher.resolveDocumentIdentity(
      filePath,
      workspaceFolderPath,
      fallbackKey
    );

    this.docIdentityCache.set(docKey, identity);
    return identity;
  }

  private async handleActiveEditor(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    if (!editor) {
      this.activeDocKey = null;
      this.emit('editor_switch', EMPTY_IDENTITY, null);
      return;
    }

    if (!this.isTrackedDocument(editor.document)) {
      this.activeDocKey = null;
      return;
    }

    this.activeDocKey = editor.document.uri.toString();
    await this.emitDocumentEvent('editor_switch', editor.document, {
      lineCount: editor.document.lineCount,
    });
  }

  private async handleDocumentChange(
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    const doc = event.document;
    const docKey = doc.uri.toString();
    const monoMs = this.monoMs();
    const lineCount = doc.lineCount;
    const languageId = doc.languageId;

    // Extract only aggregate character/line counts; discard text immediately.
    const samples: EditChangeSample[] = event.contentChanges.map((change) => ({
      insertedChars: change.text.length,
      deletedChars: change.rangeLength,
      insertedNewlines: countNewlines(change.text),
      deletedNewlines: Math.max(0, change.range.end.line - change.range.start.line),
    }));

    let reason: 'undo' | 'redo' | undefined;
    if (event.reason === vscode.TextDocumentChangeReason.Undo) {
      reason = 'undo';
    } else if (event.reason === vscode.TextDocumentChangeReason.Redo) {
      reason = 'redo';
    }

    const identity = await this.resolveIdentity(doc);
    if (!this.enabled) {
      return;
    }

    this.editAccumulator.record(
      docKey,
      identity,
      languageId,
      samples,
      lineCount,
      monoMs,
      reason
    );
  }

  private async emitDocumentEvent(
    type: TelemetryEventType,
    doc: vscode.TextDocument,
    data?: TelemetryEventData
  ): Promise<void> {
    const identity = await this.resolveIdentity(doc);
    if (!this.enabled) {
      return;
    }
    this.emit(type, identity, doc.languageId, data);
  }

  private emit(
    event: TelemetryEventType,
    identity: DocumentIdentity,
    languageId: string | null,
    data?: TelemetryEventData
  ): void {
    const record: TelemetryEvent = {
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      monoMs: this.monoMs(),
      sessionId: this.sessionId,
      installId: this.hasher.installId,
      event,
      projectId: identity.projectId,
      projectSource: identity.projectSource,
      fileId: identity.fileId,
      languageId,
      ...(data ? { data } : {}),
    };

    this.logger.enqueue(record);
  }
}
