![Mlehhhh](./images/mlehh.jpg)

# CheekyRacoon

CheekyRacoon gives students who do their homework without LLM assistance a local receipt of their work in VS Code.

## Log format

Each recorded VS Code session writes one JSONL file in the `logs` folder under the extension’s global storage directory. The first line records the extension version, VS Code version, and start time. Every subsequent line is a three-element array `[event, timestamp, previousHash]`. Timestamps are Unix milliseconds.

```jsonl
{"extensionVersion":"0.1.0","vscodeVersion":"1.85.0","timestamp":1760000000000}
["file_save",1760000001500,"tCdpU7aFgdDmb7lhS5iJ97uiHgdV-Ch8Fd6dAjN6SH4"]
```

To recompute `previousHash`, concatenate the exact preceding JSON line (excluding its newline) with its own decimal timestamp. Hash the UTF-8 bytes with SHA-256 and encode the digest as unpadded base64url.

## Events captured

The extension records `file_open`, `file_save`, `file_close`, `edit`, `editor_switch`, `window_focus`, `window_blur`, and `session_end`. Each content change notification produces one `edit` event. File contents, paths, and user identifiers stay out of the log.

Recording is offline. Set `cheekyRacoon.enabled` to `false` to pause it.

## Development

```bash
npm install
npm run compile
npm test
```

Press **F5** in VS Code to launch an Extension Development Host with CheekyRacoon active.
