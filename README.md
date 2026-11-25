![Mlehhhh](./images/mlehh.jpg)

# CheekyRacoon

CheekyRacoon is all about helping students who ARE doing their homework without LLM assistance provide a receipt of their work. It isn't a catch all to prevent all cheating-that's essentially impossible since this is an open source extension.

There are efforts made to prevent this (hash chaining, signing based on source code), but these are not guarantees.

## Student Privacy Focus

- First and foremost, this extension is completely offline. No student data ever leaves their machine without them exporting it.
- All data that IS collected has been hashed and obscured. No source code, filenames, paths, git URLs, usernames, or individual keystrokes are logged. Timing for these things IS logged.

## Events Captured

- `session_start` / `session_end`
- `window_focus` (`{ focused }`)
- `file_open` / `file_save` (`{ lineCount }`)
- `file_close`
- `editor_switch` (`{ lineCount }`)
- `edit` (`{ offset, charsInserted, charsDeleted, reason? }`)

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
