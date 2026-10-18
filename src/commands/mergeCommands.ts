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

        let funcA: FunctionRecord;

        // Step 1: Determine first function
        if (sourceItem?.func) {
          funcA = sourceItem.func;
        } else {
          const pickItemsA: FunctionQuickPickItem[] = allFunctions.map((fn) => {
            const timeline = getFunctionTimeline(fn.id);
            const fileName = path.basename(fn.filePath);
            const scope = fn.parentName && fn.parentName !== 'GLOBAL' ? ` (${fn.parentName})` : '';
            return {
              label: `$(symbol-function) ${fn.functionName}${scope}`,
              description: `${fileName} • ${timeline.length} version${timeline.length === 1 ? '' : 's'}`,
              func: fn,
            };
          });

          const selectedA = await vscode.window.showQuickPick(pickItemsA, {
            placeHolder: 'Select the first function to merge',
            title: 'FuncUndo: Merge Step 1 of 3 (Select First Function)',
          });

          if (!selectedA) return;
          funcA = selectedA.func;
        }

        // Step 2: Pick second function
        const candidatesB = allFunctions.filter((fn) => fn.id !== funcA.id);
        const pickItemsB: FunctionQuickPickItem[] = candidatesB.map((fn) => {
          const timeline = getFunctionTimeline(fn.id);
          const fileName = path.basename(fn.filePath);
          const scope = fn.parentName && fn.parentName !== 'GLOBAL' ? ` (${fn.parentName})` : '';
          return {
            label: `$(symbol-function) ${fn.functionName}${scope}`,
            description: `${fileName} • ${timeline.length} version${timeline.length === 1 ? '' : 's'}`,
            func: fn,
          };
        });

        const selectedB = await vscode.window.showQuickPick(pickItemsB, {
          placeHolder: `Select the second function to merge with '${funcA.functionName}'`,
          title: `FuncUndo: Merge Step 2 of 3 (Select Second Function)`,
        });

        if (!selectedB) return;
        const funcB = selectedB.func;

        // Step 3: Choose which function to keep (the destination)
        interface MergeDirectionItem extends vscode.QuickPickItem {
          target: FunctionRecord;
          source: FunctionRecord;
        }

        const directionItems: MergeDirectionItem[] = [
          {
            label: `$(arrow-right) Keep '${funcB.functionName}' as final function`,
            description: `Merge '${funcA.functionName}' into '${funcB.functionName}'`,
            detail: `All history from '${funcA.functionName}' will be transferred into '${funcB.functionName}'.`,
            target: funcB,
            source: funcA,
          },
          {
            label: `$(arrow-left) Keep '${funcA.functionName}' as final function`,
            description: `Merge '${funcB.functionName}' into '${funcA.functionName}'`,
            detail: `All history from '${funcB.functionName}' will be transferred into '${funcA.functionName}'.`,
            target: funcA,
            source: funcB,
          },
        ];

        const selectedDirection = await vscode.window.showQuickPick(directionItems, {
          placeHolder: 'Which function identity do you want to keep?',
          title: 'FuncUndo: Merge Step 3 of 3 (Choose Destination)',
        });

        if (!selectedDirection) return;

        const targetFunc = selectedDirection.target;
        const sourceFunc = selectedDirection.source;

        // Step 4: Confirmation
        const sourceTimeline = getFunctionTimeline(sourceFunc.id);
        const confirm = await vscode.window.showWarningMessage(
          `Merge ${sourceTimeline.length} version(s) of '${sourceFunc.functionName}' into '${targetFunc.functionName}'? The unified history will live under '${targetFunc.functionName}'.`,
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
