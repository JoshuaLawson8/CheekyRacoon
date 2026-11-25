import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { editRanges } from '../../src/edits';
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

  it('produces unrelated hashes under different salts', () => {
    const h1 = new TelemetryHasher(TelemetryHasher.generateSaltHex());
    const h2 = new TelemetryHasher(TelemetryHasher.generateSaltHex());

    assert.notEqual(h1.installId, h2.installId);
    assert.notEqual(h1.hashProject('my-project'), h2.hashProject('my-project'));

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

      const localGit = path.join(tmp, 'local-git');
      await fs.mkdir(path.join(localGit, '.git'), { recursive: true });
      const gitRootId = await matcher.resolveDocumentIdentity(
        path.join(localGit, 'a.py'),
        localGit
      );
      assert.equal(gitRootId.projectSource, 'git-root');
      assert.ok(gitRootId.projectId);

      const plainWs = path.join(tmp, 'plain-ws');
      await fs.mkdir(plainWs, { recursive: true });
      const wsId = await matcher.resolveDocumentIdentity(
        path.join(plainWs, 'b.py'),
        plainWs
      );
      assert.equal(wsId.projectSource, 'workspace');
      assert.ok(wsId.projectId);

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

describe('editRanges', () => {
  it('preserves each changed range in UTF-16 units and discards its text', () => {
    assert.deepEqual(editRanges([
      { rangeOffset: 12, rangeLength: 0, text: '🦝\r\n' },
      { rangeOffset: 5, rangeLength: 3, text: 'x' },
      { rangeOffset: 0, rangeLength: 2, text: '' },
    ], 'undo'), [
      { offset: 12, charsInserted: 4, charsDeleted: 0, reason: 'undo' },
      { offset: 5, charsInserted: 1, charsDeleted: 3, reason: 'undo' },
      { offset: 0, charsInserted: 0, charsDeleted: 2, reason: 'undo' },
    ]);
  });

  it('skips empty changes', () => {
    assert.deepEqual(editRanges([]), []);
    assert.deepEqual(editRanges([{ rangeOffset: 3, rangeLength: 0, text: '' }]), []);
  });
});

describe('JsonlTelemetryLogger', () => {
  it('exports pending range edits in notification order alongside older daily logs', async () => {
    await withTempDir(async (tmp) => {
      const logsDir = path.join(tmp, 'logs');
      const logger = new JsonlTelemetryLogger(logsDir);

      const makeEvent = (ts: string, monoMs: number): TelemetryEvent => ({
        schemaVersion: SCHEMA_VERSION,
        ts,
        monoMs,
        sessionId: 'sess-1',
        installId: 'a'.repeat(64),
        event: 'edit',
        projectId: 'b'.repeat(64),
        projectSource: 'git-remote',
        fileId: 'c'.repeat(64),
        languageId: 'typescript',
      });

      const legacy = { ...makeEvent('2026-11-23T10:00:00.000Z', 10),
        schemaVersion: 1, event: 'edit_burst', data: { changeEvents: 2, charsInserted: 3 } };
      await fs.mkdir(logsDir);
      await fs.writeFile(path.join(logsDir, 'telemetry-2026-11-23.jsonl'), JSON.stringify(legacy) + '\n');

      let resolveFirst!: (event: TelemetryEvent) => void;
      const first = new Promise<TelemetryEvent>(resolve => { resolveFirst = resolve; });
      logger.enqueue(first, editRanges([{ rangeOffset: 0, rangeLength: 0, text: 'a' }]));
      logger.enqueue(makeEvent('2026-11-24T10:00:00.001Z', 101),
        editRanges([{ rangeOffset: 1, rangeLength: 0, text: 'b' }]));
      logger.enqueue(makeEvent('2026-11-25T09:00:00.000Z', 300), editRanges([
        { rangeOffset: 9, rangeLength: 0, text: 'private code' },
        { rangeOffset: 3, rangeLength: 1, text: '' },
      ], 'redo'));

      const exportPath = path.join(tmp, 'export', 'merged.jsonl');
      const exporting = logger.exportAllLogs(exportPath);
      resolveFirst(makeEvent('2026-11-24T10:00:00.000Z', 100));
      assert.deepEqual(await exporting, { filesMerged: 3, eventCount: 5 });

      const exported = (await fs.readFile(exportPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.deepEqual(exported[0], legacy);
      assert.deepEqual(exported.slice(1).map(e => e.monoMs), [100, 101, 300, 300]);
      assert.deepEqual(exported.slice(1).map(e => e.data), [
        { offset: 0, charsInserted: 1, charsDeleted: 0 },
        { offset: 1, charsInserted: 1, charsDeleted: 0 },
        { offset: 9, charsInserted: 12, charsDeleted: 0, reason: 'redo' },
        { offset: 3, charsInserted: 0, charsDeleted: 1, reason: 'redo' },
      ]);
    });
  });
});
