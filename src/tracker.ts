import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { editRanges } from './edits';
import { TelemetryHasher } from './hasher';
import { JsonlTelemetryLogger } from './logger';
import { ProjectMatcher } from './projectMatcher';
import { DocumentIdentity, SCHEMA_VERSION, TelemetryEventData, TelemetryEventType } from './types';

const TRACKED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);
const EMPTY_IDENTITY: DocumentIdentity = { projectId: null, projectSource: 'none', fileId: null };

export class TelemetryTracker {
  private readonly sessionId = randomUUID().slice(0, 5);
  private readonly startedAt = performance.now();
  private identities = new WeakMap<vscode.TextDocument, Promise<DocumentIdentity>>();
  private projects: ProjectMatcher;

  constructor(
    private hasher: TelemetryHasher,
    private readonly logger: JsonlTelemetryLogger,
    public enabled: boolean
  ) {
    this.projects = new ProjectMatcher(hasher);
  }

  start(subscriptions: vscode.Disposable[]): void {
    const { window, workspace } = vscode;
    const switchEditor = (editor: vscode.TextEditor | undefined) => {
      const doc = editor?.document;
      this.record('editor_switch', doc, doc && [{ lineCount: doc.lineCount }]);
    };

    this.record('session_start');
    if (window.activeTextEditor) {
      switchEditor(window.activeTextEditor);
    }

    subscriptions.push(
      window.onDidChangeWindowState(({ focused }) =>
        this.record('window_focus', undefined, [{ focused }])),
      window.onDidChangeActiveTextEditor(switchEditor),
      workspace.onDidOpenTextDocument(doc => this.record('file_open', doc, [{ lineCount: doc.lineCount }])),
      workspace.onDidSaveTextDocument(doc => this.record('file_save', doc, [{ lineCount: doc.lineCount }])),
      workspace.onDidCloseTextDocument(doc => this.record('file_close', doc)),
      workspace.onDidChangeWorkspaceFolders(() => this.resetIdentities()),
      workspace.onDidChangeTextDocument(({ document, contentChanges, reason }) => {
        if (!this.isRecording(document) || !contentChanges.length) {
          return;
        }
        const reasons = vscode.TextDocumentChangeReason;
        const editReason = reason === reasons.Undo ? 'undo' : reason === reasons.Redo ? 'redo' : undefined;
        this.record('edit', document, editRanges(contentChanges, editReason));
      })
    );
  }

  resetIdentities(hasher = this.hasher): void {
    this.hasher = hasher;
    this.projects = new ProjectMatcher(hasher);
    this.identities = new WeakMap();
  }

  shutdown(): Promise<void> {
    this.record('session_end');
    this.enabled = false;
    return this.logger.flush();
  }

  private isRecording(doc?: vscode.TextDocument): boolean {
    return this.enabled && (!doc || TRACKED_SCHEMES.has(doc.uri.scheme));
  }

  private identityFor(doc: vscode.TextDocument): Promise<DocumentIdentity> {
    const cached = this.identities.get(doc);
    if (cached) {
      return cached;
    }

    const { uri } = doc;
    const workspace = vscode.workspace.getWorkspaceFolder(uri)
      ?? (uri.scheme === 'untitled' ? vscode.workspace.workspaceFolders?.[0] : undefined);
    const local = uri.scheme === 'file';
    const identity = this.projects.resolveDocumentIdentity(
      local ? uri.fsPath : null, workspace?.uri.fsPath ?? null, local ? undefined : uri.toString()
    );
    this.identities.set(doc, identity);
    return identity;
  }

  private record(
    event: TelemetryEventType,
    doc?: vscode.TextDocument,
    rows?: TelemetryEventData[]
  ): void {
    if (!this.isRecording(doc) || rows?.length === 0) {
      return;
    }

    const header = {
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      monoMs: Math.floor(performance.now() - this.startedAt),
      sessionId: this.sessionId,
      installId: this.hasher.installId.slice(0, 5),
      languageId: doc?.languageId ?? null,
      event,
    } as const;
    const identity = doc ? this.identityFor(doc) : Promise.resolve(EMPTY_IDENTITY);
    this.logger.enqueue(identity.then(ids => ({ ...header, ...ids })), rows);
  }
}
