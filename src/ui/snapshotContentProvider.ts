import * as vscode from 'vscode';
import { getSnapshotById } from '../storage/main';

/**
 * Provides read-only content for snapshot URIs (funcundo-snapshot://<snapshotId>).
 * Used by VS Code's native diff viewer (vscode.diff).
 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'funcundo-snapshot';

  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const snapshotId = uri.authority || uri.path.replace(/^\//, '');
    const data = getSnapshotById(snapshotId);
    if (!data) {
      return '// Snapshot not found in history';
    }
    return data.snapshot.content;
  }
}
