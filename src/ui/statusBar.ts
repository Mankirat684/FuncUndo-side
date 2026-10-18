import * as vscode from 'vscode';
import {
  getAllFunctionsInFile,
  getFunctionTimeline,
  FunctionRecord,
} from '../storage/main';
import { normalizeOSPath } from '../utils/pathNormalizer';

export class StatusBarController {
  private statusBarItem: vscode.StatusBarItem;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100, // Priority: next to Copilot / Go Live
    );
    this.statusBarItem.command = 'chronos.openFunctionExplorer';
    this.resetText();
    this.statusBarItem.show();
  }

  public resetText(): void {
    this.statusBarItem.text = '$(history) FuncUndo';
    this.statusBarItem.tooltip = 'FuncUndo: Click to open Function Explorer';
  }

  /**
   * Updates the status bar to show the name and version count of the function under cursor.
   */
  public updateContext(editor?: vscode.TextEditor): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      const activeEditor = editor || vscode.window.activeTextEditor;
      if (!activeEditor) {
        this.resetText();
        return;
      }

      const filePath = normalizeOSPath(activeEditor.document.uri.fsPath);
      const cursorLine = activeEditor.selection.active.line;

      const knownFunctions = getAllFunctionsInFile(filePath);
      if (knownFunctions.length === 0) {
        this.resetText();
        return;
      }

      // Check if cursor is near any tracked function in this file
      let matchedFunc: FunctionRecord | null = null;
      let matchedSnapshotCount = 0;

      for (const fn of knownFunctions) {
        const timeline = getFunctionTimeline(fn.id);
        if (timeline.length === 0) continue;

        const latest = timeline[0].snapshot;
        if (cursorLine >= latest.startLine && cursorLine <= latest.endLine) {
          matchedFunc = fn;
          matchedSnapshotCount = timeline.length;
          break;
        }
      }

      if (matchedFunc) {
        const scopePrefix =
          matchedFunc.parentName && matchedFunc.parentName !== 'GLOBAL'
            ? `${matchedFunc.parentName}.`
            : '';
        this.statusBarItem.text = `$(history) ${scopePrefix}${matchedFunc.functionName} (${matchedSnapshotCount})`;
        this.statusBarItem.tooltip = `FuncUndo: '${matchedFunc.functionName}' has ${matchedSnapshotCount} version${matchedSnapshotCount === 1 ? '' : 's'}. Click to view history or merge.`;
      } else {
        this.resetText();
      }
    }, 150);
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.statusBarItem.dispose();
  }
}
