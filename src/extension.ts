import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TelemetryHasher } from './hasher';
import { JsonlTelemetryLogger } from './logger';
import { ProjectMatcher } from './projectMatcher';
import { TelemetryTracker } from './tracker';

const SALT_SECRET_KEY = 'cheekyRacoon.installSalt.v1';

let activeTracker: TelemetryTracker | undefined;

async function getOrCreateInstallSalt(
  secrets: vscode.SecretStorage
): Promise<string> {
  const existing = await secrets.get(SALT_SECRET_KEY);
  if (existing && /^[0-9a-fA-F]{64,}$/.test(existing.trim())) {
    return existing.trim();
  }
  const fresh = TelemetryHasher.generateSaltHex();
  await secrets.store(SALT_SECRET_KEY, fresh);
  return fresh;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('cheekyRacoon');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    editBurstWindowMs: cfg.get<number>('editBurstWindowMs', 2000),
  };
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
  const projectMatcher = new ProjectMatcher(hasher);

  const logsDir = path.join(context.globalStorageUri.fsPath, 'logs');
  const logger = new JsonlTelemetryLogger(logsDir);

  const initialConfig = getConfig();
  const tracker = new TelemetryTracker(
    hasher,
    projectMatcher,
    logger,
    initialConfig.enabled,
    initialConfig.editBurstWindowMs
  );
  activeTracker = tracker;

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBar.command = 'cheekyRacoon.toggle';
  updateStatusBar(statusBar, initialConfig.enabled);
  statusBar.show();

  context.subscriptions.push(
    tracker,
    statusBar,

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cheekyRacoon')) {
        const updated = getConfig();
        tracker.setEnabled(updated.enabled);
        tracker.setEditBurstWindowMs(updated.editBurstWindowMs);
        updateStatusBar(statusBar, updated.enabled);
      }
    }),

    vscode.commands.registerCommand('cheekyRacoon.openLogsFolder', async () => {
      await fs.mkdir(logger.directoryPath, { recursive: true });
      await vscode.env.openExternal(vscode.Uri.file(logger.directoryPath));
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
      const nextEnabled = !cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', nextEnabled, vscode.ConfigurationTarget.Global);
      tracker.setEnabled(nextEnabled);
      updateStatusBar(statusBar, nextEnabled);
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
      hasher.rotateSalt(freshSalt);
      tracker.clearIdentityCaches();
      vscode.window.showInformationMessage(
        'CheekyRacoon anonymous salt rotated.'
      );
    })
  );

  tracker.start();
}

export async function deactivate(): Promise<void> {
  if (activeTracker) {
    await activeTracker.shutdown();
    activeTracker = undefined;
  }
}
