import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";

export function openLog(directory: string, projectName: string, info: { extensionVersion: string; vscodeVersion: string }) {
  mkdirSync(directory, { recursive: true });
  const file = createWriteStream(join(directory, `${projectName}-${Date.now()}.jsonl`));
  const closed = finished(file);
  closed.catch((error: any) => console.error("[CheekyRacoon] Log write failed", error));

  function append(row: object, timestamp: number) {
    const line = JSON.stringify(row);
    file.write(line + "\n");
    return createHash("sha256")
      .update(line + timestamp)
      .digest("base64url");
  }

  const start = Date.now();
  let prevHash = append({ ...info, timestamp: start }, start);
  return {
    record(event: string) {
      if (!file.writable) return;
      const timestamp = Date.now();
      prevHash = append([event, timestamp, prevHash], timestamp);
    },
    close() {
      file.end();
      return closed;
    },
  };
}
