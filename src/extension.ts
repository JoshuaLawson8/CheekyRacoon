import { dirname, join } from "node:path";
import { ExtensionContext, TextDocument, version, window, workspace } from "vscode";
import { openLog } from "./log";

const documentSchemes = new Set(["file", "untitled", "vscode-remote", "vscode-vfs"]);
let log: ReturnType<typeof openLog> | undefined;
let enabled = false;

export function activate(context: ExtensionContext) {
  const directory = join(context.globalStorageUri.fsPath, "logs");
  let focused = window.state.focused;

  function configure() {
    enabled = workspace.getConfiguration("cheekyRacoon").get("enabled", true);
    if (enabled) {
      log ??= openLog(directory, process.cwd(), {
        extensionVersion: context.extension.packageJSON.version,
        vscodeVersion: version,
      });
    }
  }

  function record(event: string, document?: TextDocument) {
    if (!enabled) return;
    const uri = document?.uri;
    if (uri && (!documentSchemes.has(uri.scheme) || dirname(uri.fsPath) === directory)) return;
    log?.record(event);
  }

  configure();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(configure),
    window.onDidChangeWindowState((state) => {
      if (state.focused === focused) return;
      focused = state.focused;
      record(focused ? "window_focus" : "window_blur");
    }),
    window.onDidChangeActiveTextEditor((editor) => record("editor_switch", editor?.document)),
    workspace.onDidOpenTextDocument((doc) => record("file_open", doc)),
    workspace.onDidSaveTextDocument((doc) => record("file_save", doc)),
    workspace.onDidCloseTextDocument((doc) => record("file_close", doc)),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (contentChanges.length) record("edit", document);
    }),
  );
}

export function deactivate() {
  if (enabled) log?.record("session_end");
  const closed = log?.close();
  log = undefined;
  return closed;
}
