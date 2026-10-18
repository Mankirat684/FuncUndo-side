import * as vscode from 'vscode';
import { ParserWorkerManager } from './worker/workerManager';
import {
  initDB,
  persistDB,
  closeDB,
  parsedFunction,
  getTimelineForFile,
  getAllFunctionsInFile,
  saveAllFunctionsSnapshots,
  getPointer,
  getSnapshotById,
  getFunctionById,
  generateFunctionId,
} from './storage/main';
import { generateFileHash } from './worker/semanticHasher';
import { GraphMasterManager } from './worker/graphMasterManager';
import { normalizeOSPath } from './utils/pathNormalizer';
import {
  undoFunctionAtCursor,
  redoFunctionAtCursor,
  revertFunctionToSnapshot,
} from './reversion/reversionEngine';
import { FunctionTreeProvider } from './ui/FunctionTreeProvider';
import { SnapshotContentProvider } from './ui/snapshotContentProvider';
import { StatusBarController } from './ui/statusBar';
import { registerMergeCommands } from './commands/mergeCommands';

let graphMasterManager: GraphMasterManager | null = null;
let workerManager: ParserWorkerManager | null = null;
let treeProvider: FunctionTreeProvider | null = null;
let statusBarController: StatusBarController | null = null;
let isDBReady = false;

interface QueueItem {
  filePath: string;
  fileText: string;
}

const processingQueue: QueueItem[] = [];
let isProcessingQueue = false;

// Track files with unsaved modifications in RAM between saves
const modifiedFilesInRAM = new Set<string>();

const debounceTimers = new Map<string, NodeJS.Timeout>();

function debouncePerFile(filePath: string, fn: () => void, delay: number): void {
  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    filePath,
    setTimeout(() => {
      debounceTimers.delete(filePath);
      fn();
    }, delay),
  );
}

function enqueueFile(filePath: string, fileText: string): void {
  const cleanPath = normalizeOSPath(filePath);
  const existingIndex = processingQueue.findIndex((item) => item.filePath === cleanPath);
  if (existingIndex !== -1) {
    processingQueue[existingIndex].fileText = fileText;
  } else {
    processingQueue.push({ filePath: cleanPath, fileText });
  }
  processNextInQueue();
}

async function processNextInQueue(): Promise<void> {
  if (isProcessingQueue || processingQueue.length === 0) return;
  if (!workerManager || !isDBReady) return;

  isProcessingQueue = true;
  const item = processingQueue.shift()!;

  try {
    await orchestrate(item.filePath, item.fileText);
  } catch (err) {
    console.error('[Orchestrator] Error processing queued file:', err);
  } finally {
    isProcessingQueue = false;
    if (processingQueue.length > 0) {
      processNextInQueue();
    }
  }
}

async function syncFirewall(): Promise<void> {
  if (!graphMasterManager) return;
  try {
    const files = await vscode.workspace.findFiles(
      '**/*.{js,ts,jsx,tsx}',
      '**/{node_modules,.git,dist,out,build,.next,coverage}/**',
    );
    const validFiles = files.map((f) => normalizeOSPath(f.fsPath));
    graphMasterManager.updateFirewall(validFiles, {});
    console.log(`[Chronos] Firewall synced: ${validFiles.length} files.`);
  } catch (err) {
    console.error('[Chronos] Failed to sync firewall:', err);
  }
}

async function indexWorkspace(): Promise<void> {
  if (!workerManager || !isDBReady) {
    console.warn('[IndexWorkspace] Skipping — worker or DB not ready');
    return;
  }

  try {
    const files = await vscode.workspace.findFiles(
      '**/*.{js,ts,jsx,tsx}',
      '**/{node_modules,.git,dist,out,build,.next,coverage}/**',
    );

    if (files.length === 0) {
      console.log('[IndexWorkspace] No supported files found in workspace.');
      return;
    }

    const validFilePaths = files.map((f) => normalizeOSPath(f.fsPath));
    graphMasterManager?.updateFirewall(validFilePaths, {});

    const statusBarMsg = vscode.window.setStatusBarMessage(
      `$(sync~spin) FuncUndo: Indexing ${validFilePaths.length} workspace files...`,
    );

    let totalFunctionsTracked = 0;
    const allFunctionsToSave: parsedFunction[] = [];

    for (const filePath of validFilePaths) {
      try {
        const fileBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        const fileText = Buffer.from(fileBytes).toString('utf8');

        const result = await workerManager.parseDocument(filePath, fileText);
        graphMasterManager?.ingestPayload(result);

        const parsedFunctions = result.functions;
        if (parsedFunctions.length === 0) continue;

        const knownFunctions = getAllFunctionsInFile(filePath);
        const timelineMap = getTimelineForFile(filePath);

        // Map: function ID -> latest known active hash
        const knownHashMap = new Map<string, string>();
        for (const kf of knownFunctions) {
          const ptr = getPointer(kf.id);
          if (ptr) {
            const snap = getSnapshotById(ptr);
            if (snap) {
              knownHashMap.set(kf.id, snap.snapshot.hash);
              continue;
            }
          }
          const t = timelineMap.get(kf.id);
          if (t && t.length > 0) {
            knownHashMap.set(kf.id, t[0].snapshot.hash);
          }
        }

        for (const fn of parsedFunctions) {
          const funcId = generateFunctionId({
            filePath,
            functionName: fn.name,
            parentName: fn.parentName,
            parentId: fn.parentId,
          });
          const lastHash = knownHashMap.get(funcId);
          // If function is not yet recorded in DB or its latest recorded hash is different
          if (!lastHash || lastHash !== fn.hash) {
            allFunctionsToSave.push({
              filePath,
              functionName: fn.name,
              parentName: fn.parentName,
              parentId: fn.parentId,
              content: fn.rawText,
              hash: fn.hash,
              dependencies: [],
              startLine: fn.range.start.row,
              endLine: fn.range.end.row,
            });
            totalFunctionsTracked++;
          }
        }
      } catch (fileErr) {
        console.warn(`[IndexWorkspace] Could not index ${filePath}:`, fileErr);
      }
    }

    if (allFunctionsToSave.length > 0) {
      saveAllFunctionsSnapshots(allFunctionsToSave);
      persistDB();
      console.log(`[IndexWorkspace] Saved ${allFunctionsToSave.length} baseline snapshots.`);
    }

    statusBarMsg.dispose();
    treeProvider?.refresh();
    statusBarController?.updateContext();

    vscode.window.setStatusBarMessage(
      `$(check) FuncUndo: Workspace indexed (${validFilePaths.length} files scanned, ${totalFunctionsTracked} functions tracked)`,
      4000,
    );
  } catch (err) {
    console.error('[IndexWorkspace] Indexing failed:', err);
  }
}

async function orchestrate(filePath: string, fileText: string): Promise<void> {
  if (!workerManager || !isDBReady) {
    console.warn('[Orchestrator] Skipping — DB not ready yet');
    return;
  }

  try {
    const result = await workerManager.parseDocument(filePath, fileText);
    graphMasterManager?.ingestPayload(result);

    const parsedFunctions = result.functions;
    if (parsedFunctions.length === 0) {
      console.log('[Orchestrator] No functions found, skipping');
      return;
    }

    // File-level early exit — skip if nothing changed
    const currentFileHash = generateFileHash(parsedFunctions.map((fn) => fn.hash));
    const knownFunctions = getAllFunctionsInFile(filePath);
    const timelineMap = getTimelineForFile(filePath);

    if (knownFunctions.length > 0) {
      const lastHashes = knownFunctions
        .map((fn) => {
          const activePointer = getPointer(fn.id);
          if (activePointer) {
            const snap = getSnapshotById(activePointer);
            if (snap) return snap.snapshot.hash;
          }
          return timelineMap.get(fn.id)?.[0]?.snapshot.hash;
        })
        .filter((h): h is string => !!h);

      const lastFileHash = generateFileHash(lastHashes);

      if (currentFileHash === lastFileHash) {
        console.log('[Orchestrator] File unchanged, skipping');
        return;
      }
    }

    // Build lookup: functionId → latest active hash
    const latestHashMap = new Map<string, string>();
    for (const fn of knownFunctions) {
      const activePointerSnapshotId = getPointer(fn.id);
      if (activePointerSnapshotId) {
        const snap = getSnapshotById(activePointerSnapshotId);
        if (snap) {
          latestHashMap.set(fn.id, snap.snapshot.hash);
          continue;
        }
      }
      const timeline = timelineMap.get(fn.id);
      if (timeline && timeline.length > 0) {
        latestHashMap.set(fn.id, timeline[0].snapshot.hash);
      }
    }

    // Diff check — filter only changed/new functions
    const functionsToSave: parsedFunction[] = [];

    for (const fn of parsedFunctions) {
      const funcId = generateFunctionId({
        filePath,
        functionName: fn.name,
        parentName: fn.parentName,
        parentId: fn.parentId,
      });
      const lastHash = latestHashMap.get(funcId);

      if (lastHash === fn.hash) {
        console.log(`[DiffCheck] No change: ${fn.name}`);
        continue;
      }

      // Rename detection — same hash, same row, different name
      let renamedFrom: string | undefined;
      for (const known of knownFunctions) {
        const timeline = timelineMap.get(known.id);
        if (!timeline || timeline.length === 0) continue;

        const latest = timeline[0].snapshot;
        if (
          latest.hash === fn.hash &&
          known.functionName !== fn.name &&
          latest.startLine === fn.range.start.row
        ) {
          renamedFrom = known.functionName;
          console.log(`[RenameHeuristic] ${renamedFrom} → ${fn.name}`);
          break;
        }
      }

      functionsToSave.push({
        filePath,
        functionName: fn.name,
        parentName: fn.parentName,
        parentId: fn.parentId,
        content: fn.rawText,
        hash: fn.hash,
        dependencies: [],
        startLine: fn.range.start.row,
        endLine: fn.range.end.row,
      });

      console.log(
        renamedFrom
          ? `[Orchestrator] Queued rename: ${renamedFrom} → ${fn.name}`
          : `[Orchestrator] Queued: ${fn.name} (${lastHash ? 'changed' : 'new'})`,
      );
    }

    if (functionsToSave.length > 0) {
      saveAllFunctionsSnapshots(functionsToSave);
      console.log(`[Orchestrator] Saved ${functionsToSave.length} functions to SQLite`);
      treeProvider?.refresh();
      statusBarController?.updateContext();
      vscode.window.setStatusBarMessage(
        `$(history) FuncUndo: Saved snapshot for ${functionsToSave.map((f) => f.functionName).join(', ')}`,
        3000,
      );
    }
  } catch (err) {
    console.error('[Orchestrator] Failed:', err);
  } finally {
    try {
      persistDB();
    } catch (err) {
      console.error('[Chronos] persistDB failed:', err);
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Chronos Extension booting...');

  // 1. Initialize and register tree view provider IMMEDIATELY (so VS Code view never shows 'no provider registered')
  treeProvider = new FunctionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('chronos.functionExplorer', treeProvider),
  );

  // 2. Register native diff content provider
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      SnapshotContentProvider.scheme,
      new SnapshotContentProvider(),
    ),
  );

  // 3. Initialize bottom-right status bar button
  statusBarController = new StatusBarController();
  context.subscriptions.push({
    dispose: () => statusBarController?.dispose(),
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      statusBarController?.updateContext(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      statusBarController?.updateContext(event.textEditor);
    }),
  );

  // 4. Register commands immediately (so commands like chronos.refreshExplorer are never 'not found')
  context.subscriptions.push(
    vscode.commands.registerCommand('chronos.undoFunction', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!workerManager || !isDBReady) {
        vscode.window.showInformationMessage(
          'FuncUndo: Initializing services, please wait a moment...',
        );
        return;
      }
      const success = await undoFunctionAtCursor(editor, workerManager);
      if (success) {
        treeProvider?.refresh();
        statusBarController?.updateContext(editor);
      }
    }),
    vscode.commands.registerCommand('chronos.redoFunction', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!workerManager || !isDBReady) {
        vscode.window.showInformationMessage(
          'FuncUndo: Initializing services, please wait a moment...',
        );
        return;
      }
      const success = await redoFunctionAtCursor(editor, workerManager);
      if (success) {
        treeProvider?.refresh();
        statusBarController?.updateContext(editor);
      }
    }),
    vscode.commands.registerCommand('chronos.revertToSnapshot', async (arg?: string | any) => {
      const snapshotId = typeof arg === 'string' ? arg : arg?.snapshotData?.snapshot?.id;
      if (!snapshotId) {
        vscode.window.showErrorMessage('Chronos: No snapshot specified for reversion.');
        return;
      }

      if (!workerManager || !isDBReady) {
        vscode.window.showInformationMessage(
          'FuncUndo: Initializing services, please wait a moment...',
        );
        return;
      }

      const snapshotData = getSnapshotById(snapshotId);
      if (!snapshotData) {
        vscode.window.showErrorMessage('Chronos: Snapshot not found in database.');
        return;
      }

      let editor = vscode.window.activeTextEditor;
      const funcRecord = getFunctionById(snapshotData.snapshot.functionHistoryId);

      // If active editor is not open or belongs to a different file, open the target file
      if (funcRecord) {
        const cleanTarget = normalizeOSPath(funcRecord.filePath);
        if (!editor || normalizeOSPath(editor.document.uri.fsPath) !== cleanTarget) {
          try {
            const doc = await vscode.workspace.openTextDocument(funcRecord.filePath);
            editor = await vscode.window.showTextDocument(doc);
          } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `Chronos: Failed to open file '${funcRecord.filePath}': ${errMsg}`,
            );
            return;
          }
        }
      }

      if (!editor) {
        vscode.window.showErrorMessage('Chronos: No active editor available for reversion.');
        return;
      }

      try {
        const success = await revertFunctionToSnapshot(editor, workerManager, snapshotId);
        if (success) {
          treeProvider?.refresh();
          statusBarController?.updateContext(editor);
        }
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Chronos: Reversion failed: ${errMsg}`);
      }
    }),
    vscode.commands.registerCommand('chronos.openFunctionExplorer', async () => {
      await vscode.commands.executeCommand('chronos.functionExplorer.focus');
    }),
    vscode.commands.registerCommand('chronos.indexWorkspace', async () => {
      await indexWorkspace();
    }),
  );

  registerMergeCommands(context, treeProvider);

  // 5. Watch for file changes for cross-file graph resolution & automatic indexing
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{js,ts,jsx,tsx}');
  context.subscriptions.push(
    fileWatcher.onDidCreate(async (uri) => {
      syncFirewall();
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        enqueueFile(uri.fsPath, Buffer.from(bytes).toString('utf8'));
      } catch {}
    }),
    fileWatcher.onDidDelete(() => syncFirewall()),
    fileWatcher,
  );

  // Track live text edits in RAM between saves
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== 'file') return;
      const supported = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
      if (!supported.includes(event.document.languageId)) return;
      if (event.contentChanges.length === 0) return;

      const cleanPath = normalizeOSPath(event.document.uri.fsPath);
      modifiedFilesInRAM.add(cleanPath);
    }),
  );

  // When a file is closed or reverted, clear its RAM modified state if clean
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme !== 'file') return;
      const cleanPath = normalizeOSPath(document.uri.fsPath);
      if (!document.isDirty) {
        modifiedFilesInRAM.delete(cleanPath);
      }
    }),
  );

  // On Ctrl+S (Save), run the pipeline only on files that were modified in RAM
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== 'file') return;
      const supported = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
      if (!supported.includes(document.languageId)) return;

      const cleanPath = normalizeOSPath(document.uri.fsPath);

      // Gate: only process if changes were made in RAM since last save!
      if (!modifiedFilesInRAM.has(cleanPath)) {
        console.log(
          `[Save] Skipping ${cleanPath} — no RAM modifications recorded since last save.`,
        );
        return;
      }

      // Consume the dirty flag for this save
      modifiedFilesInRAM.delete(cleanPath);

      debouncePerFile(cleanPath, () => enqueueFile(cleanPath, document.getText()), 200);
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      workerManager?.dispose();
      graphMasterManager?.dispose();
    },
  });

  // 6. Asynchronous non-blocking background initialization (DB, Workers, Graph, Indexing)
  (async () => {
    try {
      await initDB(context);
      isDBReady = true;
      console.log('[Chronos] DB init complete');
      treeProvider?.refresh();
      statusBarController?.updateContext();
    } catch (err) {
      console.error('[Chronos] DB init failed:', err);
      vscode.window.showErrorMessage(`FuncUndo: Database initialization failed: ${err}`);
    }

    try {
      workerManager = new ParserWorkerManager(context.extensionPath);
      await workerManager.init();
      console.log('[Chronos] Parser worker initialized');
    } catch (err) {
      console.error('[Chronos] Worker init failed:', err);
      vscode.window.showErrorMessage(`FuncUndo: AST Parser worker failed to start: ${err}`);
    }

    try {
      graphMasterManager = new GraphMasterManager(context.extensionPath);
      graphMasterManager.init();
      graphMasterManager.on('message', (message: any) => {
        if (message.type === 'QUERY_BLAST_RADIUS_RESPONSE') {
          console.log(`[Graph] Blast radius count: ${message.blastRadiusCount}`);
        }
      });
      await syncFirewall();
    } catch (err) {
      console.error('[Chronos] GraphMaster init failed:', err);
    }

    // Automatically scan the opened folder, parse all files, and record initial function snapshots
    if (isDBReady && workerManager) {
      await indexWorkspace();
      if (processingQueue.length > 0) {
        processNextInQueue();
      }
    }
  })();
}

export function deactivate() {
  closeDB();
  workerManager?.dispose();
  graphMasterManager?.dispose();
  statusBarController?.dispose();
}
