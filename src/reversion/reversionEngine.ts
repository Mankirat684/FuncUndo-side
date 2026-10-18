import * as vscode from 'vscode';
import { ParserWorkerManager } from '../worker/workerManager';
import {
  generateFunctionId,
  getPreviousSnapshot,
  getNextSnapshot,
  getSnapshotById,
  getFunctionById,
  setPointer,
  persistDB,
} from '../storage/main';
import { normalizeOSPath } from '../utils/pathNormalizer';

import { findFunctionAtCursor } from './cursorFinder';

export { findFunctionAtCursor };

/**
 * Function-scoped Undo: Steps the function enclosing cursor back 1 version.
 */
export async function undoFunctionAtCursor(
  editor: vscode.TextEditor,
  workerManager: ParserWorkerManager,
): Promise<boolean> {
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
    return false;
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
    return false;
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
    return true;
  }

  return false;
}

/**
 * Function-scoped Redo: Steps the function enclosing cursor forward 1 version.
 */
export async function redoFunctionAtCursor(
  editor: vscode.TextEditor,
  workerManager: ParserWorkerManager,
): Promise<boolean> {
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
    return false;
  }

  const functionHistoryId = generateFunctionId({
    filePath,
    functionName: targetFunc.name,
    parentName: targetFunc.parentName,
    parentId: targetFunc.parentId,
  });

  const nextSnapshot = getNextSnapshot(functionHistoryId);

  if (!nextSnapshot) {
    vscode.window.showInformationMessage(
      `Chronos: Already at the newest recorded version of '${targetFunc.name}'.`,
    );
    return false;
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
    return true;
  }

  return false;
}

/**
 * Reverts a function directly to a specific target snapshot by ID.
 */
export async function revertFunctionToSnapshot(
  editor: vscode.TextEditor,
  workerManager: ParserWorkerManager,
  targetSnapshotId: string,
): Promise<boolean> {
  const snapshotData = getSnapshotById(targetSnapshotId);
  if (!snapshotData) {
    vscode.window.showErrorMessage('Chronos: Snapshot not found.');
    return false;
  }

  const snapshot = snapshotData.snapshot;
  const filePath = normalizeOSPath(editor.document.uri.fsPath);
  const fileText = editor.document.getText();

  const parseResult = await workerManager.parseDocument(filePath, fileText);
  const cursor = {
    line: editor.selection.active.line,
    character: editor.selection.active.character,
  };

  let targetFunc = findFunctionAtCursor(parseResult.functions, cursor);
  if (!targetFunc) {
    const funcRecord = getFunctionById(snapshot.functionHistoryId);
    if (funcRecord) {
      targetFunc =
        parseResult.functions.find(
          (f) =>
            f.name === funcRecord.functionName &&
            (!funcRecord.parentName ||
              funcRecord.parentName === 'GLOBAL' ||
              f.parentName === funcRecord.parentName),
        ) ?? null;
    }
  }

  if (!targetFunc) {
    vscode.window.showInformationMessage('Chronos: Could not locate the target function in the active editor.');
    return false;
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
    return true;
  }

  return false;
}
