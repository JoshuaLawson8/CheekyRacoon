import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLog } from "../../src/log";

test("links each event to the exact preceding line and its timestamp", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cheeky-racoon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000;
  t.mock.method(Date, "now", () => now);

  const info = { extensionVersion: "0.1.0", vscodeVersion: "1.85.0" };
  const log = openLog(directory, process.cwd(), info);
  now = 2000;
  log.record("file_save");
  log.record("edit");
  await log.close();

  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const lines = (await readFile(join(directory, files[0]), "utf8")).split("\n");
  assert.equal(lines.pop(), "");
  const rows = lines.map((line) => JSON.parse(line));
  const hash = (line: string, timestamp: number) => createHash("sha256").update(line).update(String(timestamp)).digest("base64url");
  assert.deepEqual(rows, [{ ...info, timestamp: 1000 }, ["file_save", 2000, hash(lines[0], 1000)], ["edit", 2000, hash(lines[1], 2000)]]);
});
