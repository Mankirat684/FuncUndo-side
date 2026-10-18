import * as vscode from 'vscode';
import * as path from 'path';
import { GraphMasterManager } from '../worker/graphMasterManager';
import { getAllFunctionsInFile, getFunctionTimeline, FunctionRecord } from '../storage/main';
import { normalizeOSPath } from '../utils/pathNormalizer';

export class FunctionHoverProvider implements vscode.HoverProvider {
  constructor(
    private graphMasterOrGetter: GraphMasterManager | null | (() => GraphMasterManager | null),
  ) {}

  private getManager(): GraphMasterManager | null {
    if (typeof this.graphMasterOrGetter === 'function') {
      return this.graphMasterOrGetter();
    }
    return this.graphMasterOrGetter;
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | null> {
    const manager = this.getManager();
    if (!manager) {
      return null;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }

    const word = document.getText(wordRange);
    const filePath = normalizeOSPath(document.uri.fsPath);
    const knownFunctions = getAllFunctionsInFile(filePath);
    if (knownFunctions.length === 0) {
      return null;
    }

    // Match function: word matches functionName, and position is within the function range
    let matchedFunc: FunctionRecord | null = null;
    for (const fn of knownFunctions) {
      if (fn.functionName !== word) continue;

      const timeline = getFunctionTimeline(fn.id);
      if (timeline.length === 0) continue;

      const latest = timeline[0].snapshot;
      if (position.line >= latest.startLine && position.line <= latest.endLine) {
        matchedFunc = fn;
        break;
      }
    }

    if (!matchedFunc) {
      return null;
    }

    try {
      const response = await manager.queryBlastRadius(
        filePath,
        matchedFunc.functionName,
        matchedFunc.parentId,
      );

      const level = response.level || 'SAFE';
      const count = response.blastRadiusCount || 0;
      const impacted = response.impactedFunctions || [];

      const riskColor = level === 'DANGER' ? '#f44747' : level === 'WARNING' ? '#d7ba7d' : '#4ec9b0';

      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.supportHtml = true;

      const scopeInfo =
        matchedFunc.parentName && matchedFunc.parentName !== 'GLOBAL'
          ? ` *(${matchedFunc.parentName})*`
          : '';

      md.appendMarkdown(`**FuncUndo** · \`${matchedFunc.functionName}\`${scopeInfo}  \n`);
      md.appendMarkdown(
        `Blast Radius: <span style="color:${riskColor};">**${level}**</span> (${count} dependent${count === 1 ? '' : 's'})\n\n`,
      );

      if (impacted.length > 0) {
        md.appendMarkdown(`*Impacted Callers:*  \n`);
        const preview = impacted.slice(0, 4);
        for (const item of preview) {
          const parts = item.split('::');
          const name = parts[parts.length - 1];
          const fileName = path.basename(parts[0]);
          md.appendMarkdown(`• \`${name}\` (\`${fileName}\`)  \n`);
        }
        if (impacted.length > 4) {
          md.appendMarkdown(`• *+${impacted.length - 4} more*  \n`);
        }
        md.appendMarkdown(`\n`);
      }

      md.appendMarkdown(
        `[Dependency Graph](command:chronos.showDependencyGraph) · [Undo Function](command:chronos.undoFunction)\n`,
      );

      return new vscode.Hover(md, wordRange);
    } catch (err) {
      console.warn('[FunctionHoverProvider] Failed to query blast radius:', err);
      return null;
    }
  }
}
