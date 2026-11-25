![Mlehhhh](./images/mlehh.jpg)

# CheekyRacoon Telemetry (v0.1)

Anonymous, offline VS Code programming telemetry focused on zero-PII logging, irreversible cryptographic hashing, and reliable project matching.

## Privacy & Security Design

- **Per-install random salt**: A 256-bit cryptographically random key is generated on first activation and stored exclusively in VS Code's OS-backed `SecretStorage` — never written to logs or settings.
- **Domain-separated HMAC-SHA256**: `installId`, `projectId`, and `fileId` are computed with domain separation (`install`, `project`, `file`). `fileId` is further scoped by `projectId` so common filenames like `src/index.ts` do not collide across projects.
- **Metadata-only events**: No source code, filenames, paths, git URLs, usernames, or individual keystroke timings are logged. Edits are aggregated into debounced `edit_burst` summaries (char/line deltas, undo/redo counts, duration).
- **100% offline**: Events append locally to daily JSONL files in VS Code's `globalStorageUri/logs/telemetry-YYYY-MM-DD.jsonl`. No network requests are made.

## Project Matching Priority

Files are resolved locally to a canonical fingerprint (immediately HMAC-hashed and discarded):

1. `git-remote` — Normalized `origin` remote URL from `.git/config` (credentials stripped; HTTPS and SSH normalize identically so multiple clones match the same `projectId`).
2. `git-root` — Local Git repository root path (when no `origin` remote exists).
3. `workspace` — VS Code workspace folder path.
4. `none` — Loose file outside any Git repo or workspace.

## Events Captured

- `session_start` / `session_end`
- `window_focus` (`{ focused }`)
- `file_open` / `file_save` (`{ lineCount }`)
- `file_close`
- `editor_switch` (`{ lineCount }`)
- `edit_burst` (`{ changeEvents, charsInserted, charsDeleted, linesAdded, linesRemoved, undoEvents, redoEvents, durationMs, lineCount }`)

## Commands

- **CheekyRacoon: Open Logs Folder** — Opens the local JSONL logs directory.
- **CheekyRacoon: Export Telemetry Logs** — Merges all daily JSONL files into a single `.jsonl` file.
- **CheekyRacoon: Toggle Telemetry Recording** — Pauses or resumes logging (also clickable in the status bar).
- **CheekyRacoon: Reset Anonymous Salt** — Rotates the per-install secret salt so future events cannot be linked to past IDs.

## Development

```bash
npm install
npm run compile
npm test
```

Press **F5** in VS Code to launch an Extension Development Host with CheekyRacoon active.
