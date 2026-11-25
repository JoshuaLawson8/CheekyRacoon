export const SCHEMA_VERSION = 2;

export type ProjectSource = 'git-remote' | 'git-root' | 'workspace' | 'none';

export type TelemetryEventType =
  | 'session_start'
  | 'session_end'
  | 'window_focus'
  | 'file_open'
  | 'file_close'
  | 'file_save'
  | 'editor_switch'
  | 'edit';

export interface EditData {
  offset: number;
  charsInserted: number;
  charsDeleted: number;
  reason?: 'undo' | 'redo';
}

export type TelemetryEventData = { focused: boolean } | { lineCount: number } | EditData;

export interface DocumentIdentity {
  projectId: string | null;
  projectSource: ProjectSource;
  fileId: string | null;
}

export interface TelemetryEvent extends DocumentIdentity {
  schemaVersion: typeof SCHEMA_VERSION;
  ts: string;
  monoMs: number;
  sessionId: string;
  installId: string;
  event: TelemetryEventType;
  languageId: string | null;
  data?: TelemetryEventData;
}
