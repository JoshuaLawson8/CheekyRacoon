import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { EditAccumulator, FlushedEditBurst } from '../../src/editAccumulator';
import { TelemetryHasher } from '../../src/hasher';
import { JsonlTelemetryLogger } from '../../src/logger';
import {
  normalizeGitRemoteUrl,
  parseOriginRemoteFromGitConfig,
  ProjectMatcher,
} from '../../src/projectMatcher';
import { SCHEMA_VERSION, TelemetryEvent } from '../../src/types';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cheeky-racoon-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('TelemetryHasher', () => {
  it('produces deterministic 256-bit domain-separated HMAC hashes', () => {
    const salt = TelemetryHasher.generateSaltHex();
    const a = new TelemetryHasher(salt);
    const b = new TelemetryHasher(salt);

    assert.equal(a.installId, b.installId);
    assert.match(a.installId, /^[0-9a-f]{64}$/);
    assert.equal(a.hashProject('repo-1'), b.hashProject('repo-1'));
    assert.notEqual(a.hash('project', 'same'), a.hash('file', 'same'));
  });

  it('produces unrelated hashes under different salts and after rotation', () => {
    const h1 = new TelemetryHasher(TelemetryHasher.generateSaltHex());
    const h2 = new TelemetryHasher(TelemetryHasher.generateSaltHex());

    assert.notEqual(h1.installId, h2.installId);
    assert.notEqual(h1.hashProject('my-project'), h2.hashProject('my-project'));

    const oldInstallId = h1.installId;
    h1.rotateSalt(TelemetryHasher.generateSaltHex());
    assert.notEqual(h1.installId, oldInstallId);
  });

  it('scopes file hashes to their projectId', () => {
    const hasher = new TelemetryHasher(TelemetryHasher.generateSaltHex());
    const p1 = hasher.hashProject('project-a');
    const p2 = hasher.hashProject('project-b');

    assert.notEqual(
      hasher.hashFile(p1, 'src/index.ts'),
      hasher.hashFile(p2, 'src/index.ts')
    );
  });
});

describe('Git remote normalization & ProjectMatcher', () => {
  it('normalizes HTTPS, credentialed HTTPS, and SSH URLs identically', () => {
    const expected = 'github.com/ucd-lab/cheekyracoon';
    assert.equal(
      normalizeGitRemoteUrl('https://github.com/UCD-Lab/CheekyRacoon.git'),
      expected
    );
    assert.equal(
      normalizeGitRemoteUrl('https://alice:ghp_secret123@github.com/ucd-lab/cheekyracoon/'),
      expected
    );
    assert.equal(
      normalizeGitRemoteUrl('git@github.com:UCD-Lab/CheekyRacoon.git'),
      expected
    );
    assert.equal(
      normalizeGitRemoteUrl('ssh://git@github.com:22/ucd-lab/CheekyRacoon.git'),
      expected
    );
    assert.equal(normalizeGitRemoteUrl('file:///Users/alice/repo'), null);
    assert.equal(normalizeGitRemoteUrl('/local/path/repo'), null);
  });

  it('parses origin remote from .git/config', () => {
    const cfg = `
[core]
  repositoryformatversion = 0
[remote "upstream"]
  url = https://github.com/other/repo.git
[remote "origin"]
  url = git@github.com:UCD/CheekyRacoon.git
  fetch = +refs/heads/*:refs/remotes/origin/*
`;
    assert.equal(
      parseOriginRemoteFromGitConfig(cfg),
      'git@github.com:UCD/CheekyRacoon.git'
    );
  });

  it('matches two clones of the same git remote to identical projectId and fileId without leaking PII', async () => {
    await withTempDir(async (tmp) => {
      const hasher = new TelemetryHasher(TelemetryHasher.generateSaltHex());
      const matcher = new ProjectMatcher(hasher);

      const clone1 = path.join(tmp, 'alice-secret-folder-1');
      const clone2 = path.join(tmp, 'bob-moved-folder-2');

      await fs.mkdir(path.join(clone1, '.git'), { recursive: true });
      await fs.mkdir(path.join(clone1, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(clone1, '.git', 'config'),
        '[remote "origin"]\n\turl = https://alice:token@github.com/UCD/SecretProject.git\n'
      );

      await fs.mkdir(path.join(clone2, '.git'), { recursive: true });
      await fs.mkdir(path.join(clone2, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(clone2, '.git', 'config'),
        '[remote "origin"]\n\turl = git@github.com:ucd/secretproject.git\n'
      );

      const id1 = await matcher.resolveDocumentIdentity(
        path.join(clone1, 'src', 'main.ts'),
        clone1
      );
      const id2 = await matcher.resolveDocumentIdentity(
        path.join(clone2, 'src', 'main.ts'),
        clone2
      );

      assert.equal(id1.projectSource, 'git-remote');
      assert.equal(id2.projectSource, 'git-remote');
      assert.equal(id1.projectId, id2.projectId);
      assert.equal(id1.fileId, id2.fileId);

      // Verify zero raw PII/path leakage
      const serialized = JSON.stringify(id1).toLowerCase();
      for (const forbidden of ['alice', 'token', 'secretproject', 'main.ts', 'github']) {
        assert.equal(serialized.includes(forbidden), false);
      }
    });
  });

  it('falls back cleanly from git-root -> workspace -> none', async () => {
    await withTempDir(async (tmp) => {
      const hasher = new TelemetryHasher(TelemetryHasher.generateSaltHex());
      const matcher = new ProjectMatcher(hasher);

      // 1. Local git repo without origin remote
      const localGit = path.join(tmp, 'local-git');
      await fs.mkdir(path.join(localGit, '.git'), { recursive: true });
      const gitRootId = await matcher.resolveDocumentIdentity(
        path.join(localGit, 'a.py'),
        localGit
      );
      assert.equal(gitRootId.projectSource, 'git-root');
      assert.ok(gitRootId.projectId);

      // 2. Plain workspace folder (no .git)
      const plainWs = path.join(tmp, 'plain-ws');
      await fs.mkdir(plainWs, { recursive: true });
      const wsId = await matcher.resolveDocumentIdentity(
        path.join(plainWs, 'b.py'),
        plainWs
      );
      assert.equal(wsId.projectSource, 'workspace');
      assert.ok(wsId.projectId);

      // 3. Loose file outside any workspace or repo
      const looseId = await matcher.resolveDocumentIdentity(
        path.join(tmp, 'scratch.txt'),
        null
      );
      assert.equal(looseId.projectSource, 'none');
      assert.equal(looseId.projectId, null);
      assert.ok(looseId.fileId);
    });
  });
});

describe('EditAccumulator', () => {
  it('aggregates edits into a single metadata-only burst and flushes cleanly', () => {
    const bursts: FlushedEditBurst[] = [];
    const acc = new EditAccumulator(5000, (b) => bursts.push(b));
    const identity = {
      projectId: 'p1',
      projectSource: 'workspace' as const,
      fileId: 'f1',
    };

    acc.record(
      'doc-1',
      identity,
      'typescript',
      [{ insertedChars: 12, deletedChars: 0, insertedNewlines: 1, deletedNewlines: 0 }],
      10,
      1000
    );
    acc.record(
      'doc-1',
      identity,
      'typescript',
      [{ insertedChars: 3, deletedChars: 5, insertedNewlines: 0, deletedNewlines: 1 }],
      9,
      1450,
      'undo'
    );

    assert.equal(bursts.length, 0);
    acc.flushDocument('doc-1');
    assert.equal(bursts.length, 1);
    assert.deepEqual(bursts[0].data, {
      changeEvents: 2,
      charsInserted: 15,
      charsDeleted: 5,
      linesAdded: 1,
      linesRemoved: 1,
      undoEvents: 1,
      redoEvents: 0,
      durationMs: 450,
      lineCount: 9,
    });
  });
});

describe('JsonlTelemetryLogger', () => {
  it('writes ordered daily JSONL files and merges them on export', async () => {
    await withTempDir(async (tmp) => {
      const logsDir = path.join(tmp, 'logs');
      const logger = new JsonlTelemetryLogger(logsDir);

      const makeEvent = (ts: string, monoMs: number): TelemetryEvent => ({
        schemaVersion: SCHEMA_VERSION,
        ts,
        monoMs,
        sessionId: 'sess-1',
        installId: 'a'.repeat(64),
        event: 'file_save',
        projectId: 'b'.repeat(64),
        projectSource: 'git-remote',
        fileId: 'c'.repeat(64),
        languageId: 'typescript',
        data: { lineCount: 42 },
      });

      logger.enqueue(makeEvent('2026-11-24T10:00:00.000Z', 100));
      logger.enqueue(makeEvent('2026-11-24T10:01:00.000Z', 200));
      logger.enqueue(makeEvent('2026-11-25T09:00:00.000Z', 300));
      await logger.flush();

      const files = await logger.listLogFiles();
      assert.equal(files.length, 2);

      const exportPath = path.join(tmp, 'export', 'merged.jsonl');
      const summary = await logger.exportAllLogs(exportPath);
      assert.deepEqual(summary, { filesMerged: 2, eventCount: 3 });

      const exported = (await fs.readFile(exportPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TelemetryEvent);
      assert.deepEqual(
        exported.map((e) => e.monoMs),
        [100, 200, 300]
      );
    });
  });
});
