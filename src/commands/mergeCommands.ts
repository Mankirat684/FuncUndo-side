import * as vscode from 'vscode';
import * as path from 'path';
import {
  getAllTrackedFunctions,
  getFunctionTimeline,
  mergeFunctionHistories,
  FunctionRecord,
} from '../storage/main';
import { FunctionTreeItem, FunctionTreeProvider } from '../ui/FunctionTreeProvider';

interface FunctionQuickPickItem extends vscode.QuickPickItem {
  func: FunctionRecord;
}

export function registerMergeCommands(
  context: vscode.ExtensionContext,
  treeProvider: FunctionTreeProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'chronos.mergeFunctions',
      async (sourceItem?: FunctionTreeItem) => {
        const allFunctions = getAllTrackedFunctions();
        if (allFunctions.length < 2) {
          vscode.window.showInformationMessage(
            'FuncUndo: Need at least 2 tracked functions to perform a merge.',
          );
          return;
        }

        let sourceFunc: FunctionRecord;

        // Step 1: Determine source function (either clicked item or picked from list)
        if (sourceItem?.func) {
          sourceFunc = sourceItem.func;
        } else {
          const sourcePickItems: FunctionQuickPickItem[] = allFunctions.map((fn) => {
            const timeline = getFunctionTimeline(fn.id);
            const fileName = path.basename(fn.filePath);
            const scope = fn.parentName && fn.parentName !== 'GLOBAL' ? ` (${fn.parentName})` : '';
            return {
              label: `$(symbol-function) ${fn.functionName}${scope}`,
              description: `${fileName} • ${timeline.length} version${timeline.length === 1 ? '' : 's'}`,
              func: fn,
            };
          });

          const selectedSource = await vscode.window.showQuickPick(sourcePickItems, {
            placeHolder: 'Select the OLD / source function you renamed',
            title: 'FuncUndo: Merge Step 1 of 2 (Source Function)',
          });

          if (!selectedSource) return;
          sourceFunc = selectedSource.func;
        }

        // Step 2: Pick target function to merge into
        const targetCandidates = allFunctions.filter((fn) => fn.id !== sourceFunc.id);
        const targetPickItems: FunctionQuickPickItem[] = targetCandidates.map((fn) => {
          const timeline = getFunctionTimeline(fn.id);
          const fileName = path.basename(fn.filePath);
          const scope = fn.parentName && fn.parentName !== 'GLOBAL' ? ` (${fn.parentName})` : '';
          return {
            label: `$(symbol-function) ${fn.functionName}${scope}`,
            description: `${fileName} • ${timeline.length} version${timeline.length === 1 ? '' : 's'}`,
            func: fn,
          };
        });

        const selectedTarget = await vscode.window.showQuickPick(targetPickItems, {
          placeHolder: `Select the NEW target function to merge '${sourceFunc.functionName}' into`,
          title: `FuncUndo: Merge Step 2 of 2 (Target for '${sourceFunc.functionName}')`,
        });

        if (!selectedTarget) return;
        const targetFunc = selectedTarget.func;

        // Step 3: Confirmation
        const sourceTimeline = getFunctionTimeline(sourceFunc.id);
        const confirm = await vscode.window.showWarningMessage(
          `Merge ${sourceTimeline.length} version(s) of '${sourceFunc.functionName}' into '${targetFunc.functionName}'? This will unify their history into a single function.`,
          { modal: true },
          'Merge Histories',
        );

        if (confirm !== 'Merge Histories') {
          return;
        }

        try {
          const result = mergeFunctionHistories(sourceFunc.id, targetFunc.id);
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            `FuncUndo: Successfully merged ${result.mergedSnapshotCount} version(s) of '${sourceFunc.functionName}' into '${targetFunc.functionName}'.`,
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(`FuncUndo: Failed to merge functions: ${err.message}`);
        }
      },
    ),

    vscode.commands.registerCommand('chronos.refreshExplorer', () => {
      treeProvider.refresh();
      vscode.window.setStatusBarMessage('$(check) FuncUndo: Explorer refreshed', 2000);
    }),
  );
}
