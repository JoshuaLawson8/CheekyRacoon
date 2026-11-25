import * as crypto from 'node:crypto';

export type HashDomain = 'install' | 'project' | 'file';

const SALT_BYTES = 32;

/**
 * Domain-separated HMAC-SHA256 hasher keyed by a per-install random salt.
 *
 * Because the 256-bit salt lives only in OS-backed secret storage and is never
 * written to logs, hashes cannot be reversed or rainbow-tabled back to file
 * paths, repository URLs, or usernames.
 */
export class TelemetryHasher {
  private key: Buffer;
  private cachedInstallId: string;

  constructor(saltHex: string) {
    this.key = TelemetryHasher.parseSaltHex(saltHex);
    this.cachedInstallId = this.hash('install', 'v1');
  }

  static generateSaltHex(): string {
    return crypto.randomBytes(SALT_BYTES).toString('hex');
  }

  private static parseSaltHex(saltHex: string): Buffer {
    const trimmed = saltHex.trim();
    if (!/^[0-9a-fA-F]{64,}$/.test(trimmed) || trimmed.length % 2 !== 0) {
      throw new Error('Invalid salt: expected at least 32 bytes of hex');
    }
    return Buffer.from(trimmed, 'hex');
  }

  get installId(): string {
    return this.cachedInstallId;
  }

  rotateSalt(newSaltHex: string): void {
    this.key = TelemetryHasher.parseSaltHex(newSaltHex);
    this.cachedInstallId = this.hash('install', 'v1');
  }

  hash(domain: HashDomain, value: string): string {
    return crypto
      .createHmac('sha256', this.key)
      .update(`${domain}\0${value}`, 'utf8')
      .digest('hex');
  }

  hashProject(canonicalFingerprint: string): string {
    return this.hash('project', canonicalFingerprint);
  }

  /**
   * Binds a file's hash to its projectId so identically named files in
   * different projects (e.g., `src/index.ts`) produce distinct anonymous IDs.
   */
  hashFile(projectId: string | null, normalizedRelativePath: string): string {
    const scope = projectId ?? 'loose';
    return this.hash('file', `${scope}\0${normalizedRelativePath}`);
  }
}
