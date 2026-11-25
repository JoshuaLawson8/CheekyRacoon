import * as crypto from 'node:crypto';

export class TelemetryHasher {
  private readonly key: Buffer;
  readonly installId: string;

  constructor(saltHex: string) {
    const hex = saltHex.trim();
    if (!TelemetryHasher.isValidSalt(hex)) {
      throw new Error('Invalid salt: expected at least 32 bytes of hex');
    }
    this.key = Buffer.from(hex, 'hex');
    this.installId = this.hash('install', 'v1');
  }

  static generateSaltHex(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  static isValidSalt(hex: string): boolean {
    return /^(?:[0-9a-f]{2}){32,}$/i.test(hex);
  }

  hash(domain: 'install' | 'project' | 'file', value: string): string {
    return crypto
      .createHmac('sha256', this.key)
      .update(`${domain}\0${value}`, 'utf8')
      .digest('hex');
  }

  hashProject(canonicalFingerprint: string): string {
    return this.hash('project', canonicalFingerprint);
  }

  hashFile(projectId: string | null, normalizedRelativePath: string): string {
    const scope = projectId ?? 'loose';
    return this.hash('file', `${scope}\0${normalizedRelativePath}`);
  }
}
