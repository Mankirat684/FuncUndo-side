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
    public readonly parentVersionNumber?: number,
    public readonly isBranchFork: boolean = false,
  ) {
    const date = new Date(snapshotData.snapshot.createdAt);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const vPrefix = versionNumber !== undefined ? `v${versionNumber}` : 'v?';
    const label = `${vPrefix} — ${timeString}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    const lineRange = `Lines ${snapshotData.snapshot.startLine + 1}-${snapshotData.snapshot.endLine + 1}`;

    const branchTag = parentVersionNumber !== undefined && isBranchFork ? `from v${parentVersionNumber}` : '';
    if (isCurrent) {
      this.description = branchTag ? `(current) • ${branchTag}` : '(current)';
      this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    } else if (branchTag) {
      this.description = branchTag;
      this.iconPath = new vscode.ThemeIcon('git-branch');
    } else if (!snapshotData.snapshot.parentSnapshotId) {
      this.description = 'base';
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    } else {
      this.description = lineRange;
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    const parentInfo =
      parentVersionNumber !== undefined
        ? `Parent: Version ${parentVersionNumber}\n`
        : 'Parent: None (Initial)\n';
    const vLabel = versionNumber !== undefined ? `Version ${versionNumber}` : 'Snapshot';
    const activeLabel = isCurrent ? ' (Current Active)' : '';
    this.tooltip = `${vLabel}${activeLabel}\nCreated: ${date.toLocaleString()}\n${parentInfo}Hash: ${snapshotData.snapshot.hash.slice(0, 8)}\n${lineRange}`;
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
        `${func.functionName} (${vPrefix} • ${timeString}) ↔ Current File`,
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

      // Map snapshotId -> versionNumber (v1, v2, v3 based on chronological order)
      const versionMap = new Map<string, number>();
      element.snapshots.forEach((snap, index) => {
        versionMap.set(snap.snapshot.id, total - index);
      });

      // Count children per parent to detect forks
      const childCountMap = new Map<string, number>();
      for (const snap of element.snapshots) {
        if (snap.snapshot.parentSnapshotId) {
          const count = childCountMap.get(snap.snapshot.parentSnapshotId) || 0;
          childCountMap.set(snap.snapshot.parentSnapshotId, count + 1);
        }
      }

      return element.snapshots.map((snap, index) => {
        const isCurrent = snap.snapshot.id === element.currentPointerSnapshotId;
        const versionNumber = total - index;
        const parentId = snap.snapshot.parentSnapshotId;
        const parentVersionNumber = parentId ? versionMap.get(parentId) : undefined;
        // A snapshot is a branch fork if its parent has multiple children,
        // or if it branched from a non-immediate ancestor (parent != versionNumber - 1)
        const isBranchFork = parentId
          ? (childCountMap.get(parentId) ?? 0) > 1 || parentVersionNumber !== versionNumber - 1
          : false;

        return new SnapshotTreeItem(
          snap,
          isCurrent,
          element.func,
          versionNumber,
          parentVersionNumber,
          isBranchFork,
        );
      });
    }

    return [];
  }
}
