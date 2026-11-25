import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TelemetryEvent, TelemetryEventData } from './types';

export interface ExportSummary {
  filesMerged: number;
  eventCount: number;
}

export class JsonlTelemetryLogger {
  private writeQueue: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(readonly directoryPath: string) {}

  enqueue(event: TelemetryEvent | Promise<TelemetryEvent>, rows?: readonly TelemetryEventData[]): void {
    const previous = this.writeQueue;
    this.writeQueue = Promise.all([previous, event])
      .then(async ([, record]) => {
        if (!this.dirReady) {
          await fs.mkdir(this.directoryPath, { recursive: true });
          this.dirReady = true;
        }
        const filePath = path.join(this.directoryPath, `telemetry-${record.ts.slice(0, 10)}.jsonl`);
        const lines = rows
          ? rows.map(data => JSON.stringify({ ...record, data })).join('\n')
          : JSON.stringify(record);
        await fs.appendFile(filePath, lines + '\n');
      })
      .catch((err) => {
        console.error('[CheekyRacoon] Failed to write telemetry event:', err);
        return previous;
      });
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  async listLogFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.directoryPath);
      return entries
        .filter((name) => name.startsWith('telemetry-') && name.endsWith('.jsonl'))
        .sort()
        .map((name) => path.join(this.directoryPath, name));
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
