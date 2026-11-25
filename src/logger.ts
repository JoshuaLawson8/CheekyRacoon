import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TelemetryEvent } from './types';

export interface ExportSummary {
  filesMerged: number;
  eventCount: number;
}

/**
 * Offline, append-only JSONL telemetry logger storing daily log files locally.
 * Serializes writes through a promise chain to preserve strict event ordering.
 */
export class JsonlTelemetryLogger {
  private writeQueue: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(private readonly logsDir: string) {}

  get directoryPath(): string {
    return this.logsDir;
  }

  enqueue(event: TelemetryEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const fileName = `telemetry-${event.ts.slice(0, 10)}.jsonl`;
    const filePath = path.join(this.logsDir, fileName);

    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.dirReady) {
          await fs.mkdir(this.logsDir, { recursive: true });
          this.dirReady = true;
        }
        await fs.appendFile(filePath, line, 'utf8');
      })
      .catch((err) => {
        // Keep queue alive if an individual write fails.
        console.error('[CheekyRacoon] Failed to write telemetry event:', err);
      });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async listLogFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.logsDir);
      return entries
        .filter((name) => name.startsWith('telemetry-') && name.endsWith('.jsonl'))
        .sort()
        .map((name) => path.join(this.logsDir, name));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async exportAllLogs(destinationPath: string): Promise<ExportSummary> {
    await this.flush();
    const files = await this.listLogFiles();
    const chunks: string[] = [];
    let eventCount = 0;

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      eventCount += lines.length;
      if (lines.length > 0) {
        chunks.push(lines.join('\n'));
      }
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    const output = chunks.length > 0 ? `${chunks.join('\n')}\n` : '';
    await fs.writeFile(destinationPath, output, 'utf8');

    return {
      filesMerged: files.length,
      eventCount,
    };
  }
}
