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
  commonDir: string;
}

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

export function parseOriginRemoteFromGitConfig(configContent: string): string | null {
  const lines = configContent.split(/\r?\n/);
  let inOriginSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
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
        return { gitRoot: current, commonDir: dotGitPath };
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
          return { gitRoot: current, commonDir };
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

export class ProjectMatcher {
  private readonly dirCache = new Map<string, Promise<CachedProject | null>>();

  constructor(private readonly hasher: TelemetryHasher) {}

  async resolveDocumentIdentity(
    filePath: string | null,
    workspaceFolderPath: string | null,
    fallbackKey?: string
  ): Promise<DocumentIdentity> {
    const dir = filePath ? path.dirname(filePath) : workspaceFolderPath;
    const project = dir ? await this.resolveDirectoryProject(dir, workspaceFolderPath) : null;
    const projectId = project?.projectId ?? null;
    let fileKey: string | undefined;
    if (filePath) {
      fileKey = project ? toPosixRelativePath(project.rootPath, filePath) : normalizePathForHashing(filePath);
    } else if (fallbackKey) {
      fileKey = `untitled:${fallbackKey}`;
    }
    return {
      projectId,
      projectSource: project?.projectSource ?? 'none',
      fileId: fileKey === undefined ? null : this.hasher.hashFile(projectId, fileKey),
    };
  }

  private resolveDirectoryProject(
    dirPath: string,
    workspaceFolderPath: string | null
  ): Promise<CachedProject | null> {
    const cacheKey = `${normalizePathForHashing(dirPath)}|${
      workspaceFolderPath ? normalizePathForHashing(workspaceFolderPath) : ''
    }`;

    let project = this.dirCache.get(cacheKey);
    if (!project) {
      project = this.findProject(dirPath, workspaceFolderPath);
      this.dirCache.set(cacheKey, project);
    }
    return project;
  }

  private async findProject(dirPath: string, workspaceFolderPath: string | null): Promise<CachedProject | null> {
    const gitRepo = await resolveGitRepo(dirPath);
    const rootPath = gitRepo?.gitRoot ?? workspaceFolderPath;
    if (!rootPath) {
      return null;
    }
    const remote = gitRepo && await this.readNormalizedOriginUrl(gitRepo.commonDir);
    const localSource = gitRepo ? 'git-root' : 'workspace';
    const projectSource = remote ? 'git-remote' : localSource;
    return {
      rootPath,
      projectSource,
      projectId: this.hasher.hashProject(`${projectSource}:${remote ?? normalizePathForHashing(rootPath)}`),
    };
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
