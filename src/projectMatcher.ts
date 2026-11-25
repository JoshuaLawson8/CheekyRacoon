import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TelemetryHasher } from './hasher';
import { DocumentIdentity, ProjectSource } from './types';

interface CachedProject {
  projectId: string;
  projectSource: Exclude<ProjectSource, 'none'>;
  rootPath: string;
}

interface GitRepoLocation {
  gitRoot: string;
  gitDir: string;
  commonDir: string;
}

/**
 * Normalizes a Git remote URL into a credential-free canonical form so the same
 * repository hashes identically regardless of HTTPS vs SSH or auth tokens.
 *
 * Returns null for local filesystem paths or unparseable values.
 */
export function normalizeGitRemoteUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let host: string;
  let repoPath: string;

  // SCP-like SSH syntax: git@github.com:org/repo.git
  const scpMatch = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^/\\].*)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes('://')) {
    host = scpMatch[1];
    repoPath = scpMatch[2];
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === 'file:' || !parsed.hostname) {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  } else {
    return null;
  }

  const cleanHost = host.toLowerCase();
  const cleanPath = repoPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();

  if (!cleanHost || !cleanPath) {
    return null;
  }

  return `${cleanHost}/${cleanPath}`;
}

/**
 * Extracts the `url` entry from `[remote "origin"]` in a `.git/config` file.
 */
export function parseOriginRemoteFromGitConfig(configContent: string): string | null {
  const lines = configContent.split(/\r?\n/);
  let inOriginSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    if (line.startsWith('[')) {
      const sectionMatch = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
      inOriginSection = sectionMatch !== null && sectionMatch[1] === 'origin';
      continue;
    }

    if (inOriginSection) {
      const urlMatch = /^url\s*=\s*(.+)$/i.exec(line);
      if (urlMatch) {
        return urlMatch[1].trim();
      }
    }
  }

  return null;
}

export function normalizePathForHashing(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  const rel = path.relative(rootPath, targetPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? rel.toLowerCase() : rel;
}

async function resolveGitRepo(startDir: string): Promise<GitRepoLocation | null> {
  let current = path.resolve(startDir);

  while (true) {
    const dotGitPath = path.join(current, '.git');
    try {
      const stat = await fs.stat(dotGitPath);
      if (stat.isDirectory()) {
        return { gitRoot: current, gitDir: dotGitPath, commonDir: dotGitPath };
      }
      if (stat.isFile()) {
        const content = await fs.readFile(dotGitPath, 'utf8');
        const match = /^gitdir:\s*(.+)$/im.exec(content);
        if (match) {
          const gitDir = path.resolve(current, match[1].trim());
          let commonDir = gitDir;
          try {
            const commondirContent = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8');
            const relCommon = commondirContent.trim();
            if (relCommon) {
              commonDir = path.resolve(gitDir, relCommon);
            }
          } catch {
            // Standard submodule or standalone gitdir without commondir file.
          }
          return { gitRoot: current, gitDir, commonDir };
        }
      }
    } catch {
      // No .git at this directory level; walk upward.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Resolves local files and workspaces to stable, anonymous project and file IDs.
 *
 * Resolution priority:
 * 1. Git `origin` remote URL (normalized, credential-stripped) -> `git-remote`
 * 2. Git repository root path -> `git-root`
 * 3. VS Code workspace folder path -> `workspace`
 * 4. Loose file outside any repo/workspace -> `none`
 */
export class ProjectMatcher {
  private readonly dirCache = new Map<string, CachedProject | null>();

  constructor(private readonly hasher: TelemetryHasher) {}

  clearCache(): void {
    this.dirCache.clear();
  }

  async resolveDocumentIdentity(
    filePath: string | null,
    workspaceFolderPath: string | null,
    fallbackKey?: string
  ): Promise<DocumentIdentity> {
    if (!filePath) {
      const project = workspaceFolderPath
        ? await this.resolveDirectoryProject(workspaceFolderPath, workspaceFolderPath)
        : null;
      const projectId = project?.projectId ?? null;
      const projectSource = project?.projectSource ?? 'none';
      const fileId = fallbackKey
        ? this.hasher.hashFile(projectId, `untitled:${fallbackKey}`)
        : null;
      return { projectId, projectSource, fileId };
    }

    const dir = path.dirname(filePath);
    const project = await this.resolveDirectoryProject(dir, workspaceFolderPath);

    if (project) {
      const relPath = toPosixRelativePath(project.rootPath, filePath);
      return {
        projectId: project.projectId,
        projectSource: project.projectSource,
        fileId: this.hasher.hashFile(project.projectId, relPath),
      };
    }

    return {
      projectId: null,
      projectSource: 'none',
      fileId: this.hasher.hashFile(null, normalizePathForHashing(filePath)),
    };
  }

  private async resolveDirectoryProject(
    dirPath: string,
    workspaceFolderPath: string | null
  ): Promise<CachedProject | null> {
    const cacheKey = `${normalizePathForHashing(dirPath)}|${
      workspaceFolderPath ? normalizePathForHashing(workspaceFolderPath) : ''
    }`;

    if (this.dirCache.has(cacheKey)) {
      return this.dirCache.get(cacheKey) ?? null;
    }

    let resolved: CachedProject | null = null;
    const gitRepo = await resolveGitRepo(dirPath);

    if (gitRepo) {
      const remoteUrl = await this.readNormalizedOriginUrl(gitRepo.commonDir);
      if (remoteUrl) {
        resolved = {
          projectId: this.hasher.hashProject(`git-remote:${remoteUrl}`),
          projectSource: 'git-remote',
          rootPath: gitRepo.gitRoot,
        };
      } else {
        resolved = {
          projectId: this.hasher.hashProject(
            `git-root:${normalizePathForHashing(gitRepo.gitRoot)}`
          ),
          projectSource: 'git-root',
          rootPath: gitRepo.gitRoot,
        };
      }
    } else if (workspaceFolderPath) {
      resolved = {
        projectId: this.hasher.hashProject(
          `workspace:${normalizePathForHashing(workspaceFolderPath)}`
        ),
        projectSource: 'workspace',
        rootPath: workspaceFolderPath,
      };
    }

    this.dirCache.set(cacheKey, resolved);
    return resolved;
  }

  private async readNormalizedOriginUrl(gitCommonDir: string): Promise<string | null> {
    try {
      const config = await fs.readFile(path.join(gitCommonDir, 'config'), 'utf8');
      const rawUrl = parseOriginRemoteFromGitConfig(config);
      return rawUrl ? normalizeGitRemoteUrl(rawUrl) : null;
    } catch {
      return null;
    }
  }
}
