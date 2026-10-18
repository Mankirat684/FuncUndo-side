import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDrizzleDB, persistDB } from './db';
import { getDB } from './db';
import {
  snapshots,
  dependencies,
  functionHistory,
  NewSnapshot,
  NewDependency,
} from './schema';
import { upsertFunction } from './functions';
import { functionIdentity } from './functions';
import { setPointer } from './pointer';

export interface parsedFunction {
  filePath: string;
  functionName: string;
  parentName: string;
  parentId: string;
  content: string;
  hash: string;
  dependencies: string[]; // id of functions this one calls
  startLine: number;
  endLine: number;
}

export function saveSnapshot(fn: parsedFunction): string {
  const identity: functionIdentity = {
    filePath: fn.filePath,
    functionName: fn.functionName,
    parentName: fn.parentName,
    parentId: fn.parentId,
  };
  const functionHistoryId = upsertFunction(identity);

  const snapshotId = crypto.randomUUID();

  // Insert snapshot record
  const newSnapshot: NewSnapshot = {
    id: snapshotId,
    functionHistoryId: functionHistoryId,
    content: fn.content,
    hash: fn.hash,
    startLine: fn.startLine,
    endLine: fn.endLine,
    createdAt: Date.now(),
  };
  const db = getDrizzleDB();
  db.insert(snapshots).values(newSnapshot).run();

  // Insert dependencies — each function this snapshot calls
  for (const depId of fn.dependencies) {
    // Only insert if the dependencyId exists in function_history to avoid FK violation
    const exists = db
      .select()
      .from(functionHistory)
      .where(eq(functionHistory.id, depId))
      .get();

    if (!exists) continue;

    const dep: NewDependency = {
      id: crypto.randomUUID(),
      snapshotId: snapshotId,
      dependencyId: depId,
      type: 'calls',
    };
    db.insert(dependencies).values(dep).run();
  }

  setPointer(functionHistoryId, snapshotId);
  return snapshotId;
}

export function saveAllFunctionsSnapshots(functions: parsedFunction[]): void {
  if (functions.length === 0) return;

  const sqlJsDb = getDB();

  sqlJsDb.run('BEGIN TRANSACTION');
  try {
    for (const fn of functions) {
      saveSnapshot(fn);
    }
    sqlJsDb.run('COMMIT');
    persistDB();
    console.log(`[FuncUndo] ${functions.length} functions saved`);
  } catch (err) {
    sqlJsDb.run('ROLLBACK');
    console.error('[FuncUndo] Transaction failed, rolled back:', err);
    throw err;
  }
}
