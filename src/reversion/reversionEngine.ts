import * as vscode from 'vscode';
import { ParserWorkerManager } from '../worker/workerManager';
import {
  generateFunctionId,
  getPreviousSnapshot,
  getNextSnapshots,
  getSnapshotById,
  getFunctionById,
  setPointer,
  persistDB,
  SnapshotRecord,
} from '../storage/main';
import { normalizeOSPath } from '../utils/pathNormalizer';

import {
  findFunctionAtCursor,
  findFunctionByIdentity,
  FunctionTargetIdentity,
} from './cursorFinder';

export { findFunctionAtCursor, findFunctionByIdentity };
export type { FunctionTargetIdentity };

export interface ReversionResult {
  success: boolean;
  functionName?: string;
  filePath?: string;
  parentId?: string;
}

/**
 * Function-scoped Undo: Steps the function enclosing cursor back 1 version.
 */
export async function undoFunctionAtCursor(
  editor: vscode.TextEditor,
  workerManager: ParserWorkerManager,
): Promise<ReversionResult> {
  const filePath = normalizeOSPath(editor.document.uri.fsPath);
  const fileText = editor.document.getText();
  const cursor = {
    line: editor.selection.active.line,
    character: editor.selection.active.character,
  };

  const parseResult = await workerManager.parseDocument(filePath, fileText);
  const targetFunc = findFunctionAtCursor(parseResult.functions, cursor);

  if (!targetFunc) {
    vscode.window.showInformationMessage('Chronos: No function found at current cursor position.');
    return { success: false };
  }

  const functionHistoryId = generateFunctionId({
    filePath,
    functionName: targetFunc.name,
    parentName: targetFunc.parentName,
    parentId: targetFunc.parentId,
  });

  const prevSnapshot = getPreviousSnapshot(functionHistoryId);

  if (!prevSnapshot) {
    vscode.window.showInformationMessage(
      `Chronos: Already at the oldest recorded version of '${targetFunc.name}'.`,
    );
    return { success: false };
  }

  // Replace live AST range with older snapshot content
  const liveRange = new vscode.Range(
    new vscode.Position(targetFunc.range.start.row, targetFunc.range.start.column),
    new vscode.Position(targetFunc.range.end.row, targetFunc.range.end.column),
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, liveRange, prevSnapshot.content);
  const applied = await vscode.workspace.applyEdit(edit);

  if (applied) {
    setPointer(functionHistoryId, prevSnapshot.id);
    persistDB();

    const timestamp = new Date(prevSnapshot.createdAt).toLocaleTimeString();
    vscode.window.setStatusBarMessage(
      `$(history) Chronos: Reverted '${targetFunc.name}' to version from ${timestamp}`,
      4000,
    );
    return {
      success: true,
      functionName: targetFunc.name,
      filePath,
      parentId: targetFunc.parentId,
    };
  }

  vscode.window.showErrorMessage(`Chronos: Failed to apply edit to undo '${targetFunc.name}'.`);
  return { success: false };
}

/**
 * Function-scoped Redo: Steps the function enclosing cursor forward 1 version.
 */
export async function redoFunctionAtCursor(
  editor: vscode.TextEditor,
  workerManager: ParserWorkerManager,
): Promise<ReversionResult> {
  const filePath = normalizeOSPath(editor.document.uri.fsPath);
  const fileText = editor.document.getText();
  const cursor = {
    line: editor.selection.active.line,
    character: editor.selection.active.character,
  };

  const parseResult = await workerManager.parseDocument(filePath, fileText);
  const targetFunc = findFunctionAtCursor(parseResult.functions, cursor);

  if (!targetFunc) {
    vscode.window.showInformationMessage('Chronos: No function found at current cursor position.');
    return { success: false };
  }

  const functionHistoryId = generateFunctionId({
    filePath,
    functionName: targetFunc.name,
    parentName: targetFunc.parentName,
    parentId: targetFunc.parentId,
  });

  const nextSnapshots = getNextSnapshots(functionHistoryId);

  if (nextSnapshots.length === 0) {
    vscode.window.showInformationMessage(
      `Chronos: Already at the newest recorded version of '${targetFunc.name}'.`,
    );
    return { success: false };
  }

  let nextSnapshot: SnapshotRecord;

  if (nextSnapshots.length === 1) {
    nextSnapshot = nextSnapshots[0];
  } else {
    // Multiple child branches detected from this state
    interface BranchQuickPickItem extends vscode.QuickPickItem {
      snapshot: SnapshotRecord;
    }

    const items: BranchQuickPickItem[] = nextSnapshots.map((snap, idx) => {
      const timeStr = new Date(snap.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const firstLine = snap.content.split('\n')[0].trim().slice(0, 50);
      const isLatest = idx === 0;

      return {
        label: `$(git-branch) Branch ${nextSnapshots.length - idx}: ${timeStr}${isLatest ? ' (latest)' : ''}`,
        description: `Lines ${snap.startLine + 1}-${snap.endLine + 1}`,
        detail: firstLine,
        snapshot: snap,
      };
    });

    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: `Multiple redo branches found for '${targetFunc.name}'. Select a branch to advance to:`,
    });

    if (!chosen) {
      return { success: false };
    }

    nextSnapshot = chosen.snapshot;
  }

  // Replace live AST range with newer snapshot content
  const liveRange = new vscode.Range(
    new vscode.Position(targetFunc.range.start.row, targetFunc.range.start.column),
    new vscode.Position(targetFunc.range.end.row, targetFunc.range.end.column),
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, liveRange, nextSnapshot.content);
  const applied = await vscode.workspace.applyEdit(edit);

  if (applied) {
    setPointer(functionHistoryId, nextSnapshot.id);
    persistDB();

    const timestamp = new Date(nextSnapshot.createdAt).toLocaleTimeString();
    vscode.window.setStatusBarMessage(
      `$(history) Chronos: Advanced '${targetFunc.name}' to version from ${timestamp}`,
      4000,
    );
    return {
      success: true,
      functionName: targetFunc.name,
      filePath,
      parentId: targetFunc.parentId,
    };
  }

  vscode.window.showErrorMessage(`Chronos: Failed to apply edit to redo '${targetFunc.name}'.`);
  return { success: false };
}

/**
 * Reverts a function directly to a specific target snapshot by ID.
 * Resolves the target function strictly by its owning identity, never by cursor position.
 */
export async function revertFunctionToSnapshot(
  editor: vscode.TextEditor,
  workerManager: ParserWorkerManager,
  targetSnapshotId: string,
): Promise<ReversionResult> {
  const snapshotData = getSnapshotById(targetSnapshotId);
  if (!snapshotData) {
    vscode.window.showErrorMessage('Chronos: Snapshot not found.');
    return { success: false };
  }

  const snapshot = snapshotData.snapshot;
  const funcRecord = getFunctionById(snapshot.functionHistoryId);
  if (!funcRecord) {
    vscode.window.showErrorMessage('Chronos: Owning function record for snapshot not found.');
    return { success: false };
  }

  const filePath = normalizeOSPath(editor.document.uri.fsPath);
  const targetFilePath = normalizeOSPath(funcRecord.filePath);
  if (filePath !== targetFilePath) {
    vscode.window.showErrorMessage(
      `Chronos: Active editor file does not match target snapshot file.`,
    );
    return { success: false };
  }

  const fileText = editor.document.getText();
  let parseResult;
  try {
    parseResult = await workerManager.parseDocument(filePath, fileText);
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Chronos: Failed to parse document: ${errorMsg}`);
    return { success: false };
  }

  const targetFunc = findFunctionByIdentity(parseResult.functions, {
    functionName: funcRecord.functionName,
    parentName: funcRecord.parentName,
    parentId: funcRecord.parentId,
  });

  if (!targetFunc) {
    // Function was deleted from document — resurrect at bottom of file
    const doc = editor.document;
    const lastLine = doc.lineAt(doc.lineCount - 1);
    const insertPos = lastLine.range.end;
    const trimmed = snapshot.content.trim();
    const isNamedDecl =
      trimmed.startsWith('function ') ||
      trimmed.startsWith('async function ') ||
      trimmed.startsWith('export function ') ||
      trimmed.startsWith('export async function ') ||
      trimmed.startsWith('export default function');

    const formattedCode = isNamedDecl
      ? snapshot.content
      : `const ${funcRecord.functionName} = ${snapshot.content};`;

    const insertText = `\n\n${formattedCode}\n`;

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, insertPos, insertText);
    const applied = await vscode.workspace.applyEdit(edit);

    if (applied) {
      setPointer(snapshot.functionHistoryId, snapshot.id);
      persistDB();
      vscode.window.showInformationMessage(
        `FuncUndo: Resurrected deleted function '${funcRecord.functionName}' at bottom of file.`,
      );
      return {
        success: true,
        functionName: funcRecord.functionName,
        filePath,
        parentId: funcRecord.parentId,
      };
    }

    vscode.window.showErrorMessage(
      `FuncUndo: Failed to resurrect deleted function '${funcRecord.functionName}'.`,
    );
    return { success: false };
  }

  const liveRange = new vscode.Range(
    new vscode.Position(targetFunc.range.start.row, targetFunc.range.start.column),
    new vscode.Position(targetFunc.range.end.row, targetFunc.range.end.column),
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, liveRange, snapshot.content);
  const applied = await vscode.workspace.applyEdit(edit);

  if (applied) {
    setPointer(snapshot.functionHistoryId, snapshot.id);
    persistDB();
    vscode.window.showInformationMessage(`Chronos: Reverted '${targetFunc.name}' successfully.`);
    return {
      success: true,
      functionName: targetFunc.name,
      filePath,
      parentId: targetFunc.parentId,
    };
  }

  vscode.window.showErrorMessage(`Chronos: Failed to apply edit to revert '${targetFunc.name}'.`);
  return { success: false };
}
