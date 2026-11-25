import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TelemetryHasher } from './hasher';
import { JsonlTelemetryLogger } from './logger';
import { TelemetryTracker } from './tracker';

const SALT_SECRET_KEY = 'cheekyRacoon.installSalt.v1';

let activeTracker: TelemetryTracker | undefined;

async function getOrCreateInstallSalt(
  secrets: vscode.SecretStorage
): Promise<string> {
  const existing = (await secrets.get(SALT_SECRET_KEY))?.trim();
  if (existing && TelemetryHasher.isValidSalt(existing)) {
    return existing;
  }
  const fresh = TelemetryHasher.generateSaltHex();
  await secrets.store(SALT_SECRET_KEY, fresh);
  return fresh;
}

function recordingEnabled(): boolean {
  return vscode.workspace.getConfiguration('cheekyRacoon').get('enabled', true);
}

function updateStatusBar(item: vscode.StatusBarItem, enabled: boolean): void {
  item.text = enabled ? '$(pulse) Telemetry: On' : '$(circle-slash) Telemetry: Paused';
  item.tooltip = enabled
    ? 'CheekyRacoon anonymous offline telemetry is active. Click to pause.'
    : 'CheekyRacoon telemetry is paused. Click to resume.';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const saltHex = await getOrCreateInstallSalt(context.secrets);
  const hasher = new TelemetryHasher(saltHex);
  const logsDir = path.join(context.globalStorageUri.fsPath, 'logs');
  const logger = new JsonlTelemetryLogger(logsDir);
  const tracker = new TelemetryTracker(hasher, logger, recordingEnabled());
  activeTracker = tracker;

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBar.command = 'cheekyRacoon.toggle';
  updateStatusBar(statusBar, tracker.enabled);
  statusBar.show();

  context.subscriptions.push(
    statusBar,

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cheekyRacoon.enabled')) {
        tracker.enabled = recordingEnabled();
        updateStatusBar(statusBar, tracker.enabled);
      }
    }),

    vscode.commands.registerCommand('cheekyRacoon.openLogsFolder', async () => {
      await fs.mkdir(logsDir, { recursive: true });
      await vscode.env.openExternal(vscode.Uri.file(logsDir));
    }),

    vscode.commands.registerCommand('cheekyRacoon.exportLogs', async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`cheeky-racoon-telemetry-${stamp}.jsonl`),
        filters: { 'JSON Lines': ['jsonl'] },
        saveLabel: 'Export Telemetry Logs',
      });

      if (!saveUri) {
        return;
      }

      const summary = await logger.exportAllLogs(saveUri.fsPath);
      vscode.window.showInformationMessage(
        `Exported ${summary.eventCount} anonymous telemetry event(s) from ${summary.filesMerged} log file(s).`
      );
    }),

    vscode.commands.registerCommand('cheekyRacoon.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('cheekyRacoon');
      const nextEnabled = !tracker.enabled;
      const target = cfg.inspect<boolean>('enabled')?.workspaceValue === undefined
        ? vscode.ConfigurationTarget.Global
        : vscode.ConfigurationTarget.Workspace;
      await cfg.update('enabled', nextEnabled, target);
      vscode.window.showInformationMessage(
        nextEnabled
          ? 'CheekyRacoon telemetry resumed.'
          : 'CheekyRacoon telemetry paused.'
      );
    }),

    vscode.commands.registerCommand('cheekyRacoon.resetSalt', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Resetting the anonymous salt will generate new irreversible IDs for future events. Previously logged IDs will no longer link to new ones.',
        { modal: true },
        'Reset Salt'
      );
      if (choice !== 'Reset Salt') {
        return;
      }

      const freshSalt = TelemetryHasher.generateSaltHex();
      await context.secrets.store(SALT_SECRET_KEY, freshSalt);
      tracker.resetIdentities(new TelemetryHasher(freshSalt));
      vscode.window.showInformationMessage(
        'CheekyRacoon anonymous salt rotated.'
      );
    })
  );

  tracker.start(context.subscriptions);
}

export async function deactivate(): Promise<void> {
  await activeTracker?.shutdown();
  activeTracker = undefined;
}
