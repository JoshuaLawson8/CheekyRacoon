export const SCHEMA_VERSION = 1 as const;

export type ProjectSource = 'git-remote' | 'git-root' | 'workspace' | 'none';

export type TelemetryEventType =
  | 'session_start'
  | 'session_end'
  | 'window_focus'
  | 'file_open'
  | 'file_close'
  | 'file_save'
  | 'editor_switch'
  | 'edit_burst';

export interface WindowFocusData {
  focused: boolean;
}

export interface FileMetricData {
  lineCount: number;
}

export interface EditBurstData {
  changeEvents: number;
  charsInserted: number;
  charsDeleted: number;
  linesAdded: number;
  linesRemoved: number;
  undoEvents: number;
  redoEvents: number;
  durationMs: number;
  lineCount: number;
}

export type TelemetryEventData =
  | WindowFocusData
  | FileMetricData
  | EditBurstData;

export interface DocumentIdentity {
  projectId: string | null;
  projectSource: ProjectSource;
  fileId: string | null;
}

/**
 * Strictly metadata-only telemetry record.
 * Contains no raw file paths, repository URLs, usernames, or source code.
 */
export interface TelemetryEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  ts: string;
  monoMs: number;
  sessionId: string;
  installId: string;
  event: TelemetryEventType;
  projectId: string | null;
  projectSource: ProjectSource;
  fileId: string | null;
  languageId: string | null;
  data?: TelemetryEventData;
}
