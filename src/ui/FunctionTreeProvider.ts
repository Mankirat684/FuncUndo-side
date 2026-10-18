import * as vscode from 'vscode';
import * as path from 'path';
import {
  getAllTrackedFunctions,
  getFunctionTimeline,
  getPointer,
  FunctionRecord,
  SnapshotWithDependencies,
} from '../storage/main';
import { SnapshotContentProvider } from './snapshotContentProvider';

export type TreeItemNode = FileTreeItem | FunctionTreeItem | SnapshotTreeItem;

export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly functions: FunctionRecord[],
  ) {
    const fileName = path.basename(filePath);
    super(fileName, vscode.TreeItemCollapsibleState.Expanded);

    this.tooltip = filePath;
    this.description = `${functions.length} function${functions.length === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'fileItem';
  }
}

export class FunctionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly func: FunctionRecord,
    public readonly snapshots: SnapshotWithDependencies[],
    public readonly currentPointerSnapshotId: string | null,
  ) {
    super(func.functionName, vscode.TreeItemCollapsibleState.Collapsed);

    const isMethod = func.parentName && func.parentName !== 'GLOBAL';
    this.iconPath = isMethod
      ? new vscode.ThemeIcon('symbol-method')
      : new vscode.ThemeIcon('symbol-function');

    const parentLabel = isMethod ? `${func.parentName} • ` : '';
    this.description = `${parentLabel}${snapshots.length} version${snapshots.length === 1 ? '' : 's'}`;
    this.tooltip = `${func.filePath}\nFunction: ${func.functionName}\nParent: ${func.parentName} (${func.parentId})\nVersions: ${snapshots.length}`;
    this.contextValue = 'functionItem';
  }
}

export class SnapshotTreeItem extends vscode.TreeItem {
  constructor(
    public readonly snapshotData: SnapshotWithDependencies,
    public readonly isCurrent: boolean,
    public readonly func: FunctionRecord,
    public readonly versionNumber?: number,
  ) {
    const date = new Date(snapshotData.snapshot.createdAt);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const label = versionNumber !== undefined ? `v${versionNumber} — ${timeString}` : timeString;
    super(label, vscode.TreeItemCollapsibleState.None);

    const lineRange = `Lines ${snapshotData.snapshot.startLine + 1}-${snapshotData.snapshot.endLine + 1}`;
    this.description = isCurrent ? '(current)' : lineRange;
    this.iconPath = isCurrent
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-outline');

    const vLabel = versionNumber !== undefined ? `Version ${versionNumber}\n` : '';
    this.tooltip = `${vLabel}Created: ${date.toLocaleString()}\nHash: ${snapshotData.snapshot.hash.slice(0, 8)}\n${lineRange}`;
    this.contextValue = isCurrent ? 'currentSnapshotItem' : 'snapshotItem';

    // Click triggers diff viewer
    const uri = vscode.Uri.parse(
      `${SnapshotContentProvider.scheme}:///${snapshotData.snapshot.id}/${func.functionName}.js`,
    );

    this.command = {
      command: 'vscode.diff',
      title: 'View Snapshot Diff',
      arguments: [
        uri,
        vscode.Uri.file(func.filePath),
        `${func.functionName} (${timeString}) ↔ Current File`,
      ],
    };
  }
}

export class FunctionTreeProvider implements vscode.TreeDataProvider<TreeItemNode> {
  private onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItemNode | undefined | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: TreeItemNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TreeItemNode): Promise<TreeItemNode[]> {
    if (!element) {
      // Root level: Group functions by file
      const allFunctions = getAllTrackedFunctions();
      if (allFunctions.length === 0) {
        return [];
      }

      const fileMap = new Map<string, FunctionRecord[]>();
      for (const fn of allFunctions) {
        const list = fileMap.get(fn.filePath) || [];
        list.push(fn);
        fileMap.set(fn.filePath, list);
      }

      const fileItems: FileTreeItem[] = [];
      for (const [filePath, funcs] of fileMap.entries()) {
        fileItems.push(new FileTreeItem(filePath, funcs));
      }

      return fileItems;
    }

    if (element instanceof FileTreeItem) {
      // Second level: Functions in the file
      const functionItems: FunctionTreeItem[] = [];
      for (const func of element.functions) {
        const timeline = getFunctionTimeline(func.id);
        const pointer = getPointer(func.id);
        functionItems.push(new FunctionTreeItem(func, timeline, pointer));
      }
      return functionItems;
    }

    if (element instanceof FunctionTreeItem) {
      // Third level: Snapshots of the function
      const total = element.snapshots.length;
      return element.snapshots.map((snap, index) => {
        const isCurrent = snap.snapshot.id === element.currentPointerSnapshotId;
        const versionNumber = total - index;
        return new SnapshotTreeItem(snap, isCurrent, element.func, versionNumber);
      });
    }

    return [];
  }
}
