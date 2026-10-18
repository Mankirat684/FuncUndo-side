import { parentPort } from 'worker_threads';
import Parser from 'web-tree-sitter';
import * as path from 'path';
import { IntraFileEdge, WorkerMessage, WorkerParseSuccess } from '../lib/types';
import { extractFunctions } from './astTraverser';
import { generateFileHash } from './semanticHasher';
import { resolveExports } from './exportResolver';
import { extractImports } from './importExtractor';

// Safety check: Ensure this file is only run as a Worker thread
if (!parentPort) {
  throw new Error('Fatal: parser.worker.ts must be run as a Node.js Worker thread.');
}

let parser: Parser | null = null;
let jsLanguage: Parser.Language | null = null;
let tsLanguage: Parser.Language | null = null;
let tsxLanguage: Parser.Language | null = null;

async function bootParser() {
  try {
    const runtimeWasmPath = path.join(__dirname, '..', 'wasm', 'tree-sitter.wasm');

    await Parser.init({
      locateFile() {
        return runtimeWasmPath;
      },
    });
    parser = new Parser();

    const wasmDir = path.join(__dirname, '..', 'wasm');
    const wasmPath = path.join(wasmDir, 'tree-sitter-javascript.wasm');
    jsLanguage = await Parser.Language.load(wasmPath);

    try {
      tsLanguage = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-typescript.wasm'));
    } catch (e) {
      console.warn('[Worker] Could not load TypeScript grammar, falling back to JavaScript:', e);
    }

    try {
      tsxLanguage = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-tsx.wasm'));
    } catch (e) {
      console.warn(
        '[Worker] Could not load TSX grammar, falling back to TypeScript/JavaScript:',
        e,
      );
    }

    parser.setLanguage(jsLanguage);

    console.log('[Worker] WASM Engine booted and JavaScript/TypeScript/TSX grammars loaded.');

    // tell main thread worker is ready
    parentPort?.postMessage({
      type: 'WORKER_READY',
    });
  } catch (error) {
    console.error('[Worker] Fatal Error booting WASM engine:', error);
  }
}

// Start the boot sequence immediately
bootParser();

// Listen for messages from the Main Thread
parentPort.on('message', async (message: WorkerMessage) => {
  if (message.type === 'PARSE_REQUEST') {
    const startTime = Date.now();
    if (!parser) {
      parentPort?.postMessage({
        type: 'PARSE_ERROR',
        jobId: message.jobId,
        filePath: message.filePath,
        errorMessage: 'WASM Parser engine is not fully booted yet.',
      });
      return;
    }

    try {
      const ext = path.extname(message.filePath).toLowerCase();
      if (ext === '.tsx') {
        parser.setLanguage(tsxLanguage || tsLanguage || jsLanguage!);
      } else if (ext === '.ts') {
        parser.setLanguage(tsLanguage || jsLanguage!);
      } else {
        parser.setLanguage(jsLanguage!);
      }

      const tree = parser.parse(message.fileContent);
      const rootNode = tree.rootNode;

      const resolvedImports = extractImports(rootNode);

      // 12: Walk the `rootNode` to find specific functions.
      const functions = extractFunctions(rootNode, resolvedImports);

      const { proxyExports, wildcardExports } = resolveExports(rootNode, functions);

      // Generate the Master File Hash by pulling the individual hashes we just created
      const functionHashes = functions.map((f) => f.hash);
      const masterFileHash = generateFileHash(functionHashes);

      console.log(
        `[Worker] Parsed ${message.filePath} and extracted ${functions.length} functions in ${Date.now() - startTime}ms`,
      );

      // Generate intra-file edges
      const edges: IntraFileEdge[] = [];
      const localNames = new Set(functions.map((f) => f.name));
      for (const fn of functions) {
        for (const callee of fn.calls) {
          if (localNames.has(callee)) {
            edges.push({
              callerName: fn.name,
              calleeName: callee,
            });
          }
        }
      }

      const successPayload: WorkerParseSuccess = {
        type: 'PARSE_SUCCESS',
        jobId: message.jobId,
        filePath: message.filePath,
        functions: functions,
        fileHash: masterFileHash,
        proxyExports: proxyExports,
        wildcardExports: wildcardExports,
        edges: edges,
        imports: resolvedImports,
        processingTimeMs: Date.now() - startTime,
      };

      parentPort?.postMessage(successPayload);

      tree.delete();
    } catch (error: any) {
      // THE STRUCTURED CLONE FIX ---
      // Manually extract properties because the IPC bridge strips Error prototypes
      const errorMessage = error instanceof Error ? error.message : 'Unknown parsing error';
      const errorStack = error instanceof Error ? error.stack : '';

      console.error(`[Worker] Failed to parse ${message.filePath}:`, errorMessage);

      // Send the flattened plain JSON object
      parentPort?.postMessage({
        type: 'PARSE_ERROR',
        jobId: message.jobId,
        filePath: message.filePath,
        errorMessage: errorMessage,
        errorStack: errorStack,
      });
    }
  }
});
