import * as crypto from 'crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDrizzleDB, getDB, persistDB, isDBInitialized } from './db';
import { functionHistory, NewFunction, snapshots, dependencies, pointers } from './schema';
import { normalizeOSPath } from '../utils/pathNormalizer';
import { setPointer } from './pointer';

export interface functionIdentity {
  filePath: string;
  functionName: string;
  parentName: string;
  parentId: string;
}

export function generateFunctionId(identity: functionIdentity): string {
  const cleanPath = normalizeOSPath(identity.filePath);
  const rawID = `${cleanPath}::${identity.functionName}::${identity.parentName || 'GLOBAL'}::${identity.parentId || 'GLOBAL'}`;
  return crypto.createHash('sha256').update(rawID).digest('hex');
}

export function upsertFunction(identity: functionIdentity): string {
  const cleanPath = normalizeOSPath(identity.filePath);
  const normalizedIdentity: functionIdentity = {
    filePath: cleanPath,
    functionName: identity.functionName,
    parentName: identity.parentName || 'GLOBAL',
    parentId: identity.parentId || 'GLOBAL',
  };
  const id = generateFunctionId(normalizedIdentity);

  const db = getDrizzleDB();
  const existing = db
    .select()
    .from(functionHistory)
    .where(
      and(
        eq(functionHistory.filePath, normalizedIdentity.filePath),
        eq(functionHistory.functionName, normalizedIdentity.functionName),
        eq(functionHistory.parentName, normalizedIdentity.parentName),
        eq(functionHistory.parentId, normalizedIdentity.parentId),
      ),
    )
    .all();

  if (existing.length === 0) {
    const record: NewFunction = {
      id,
      filePath: normalizedIdentity.filePath,
      functionName: normalizedIdentity.functionName,
      parentName: normalizedIdentity.parentName,
      parentId: normalizedIdentity.parentId,
    };

    db.insert(functionHistory)
      .values(record)
      .onConflictDoNothing({
        target: [
          functionHistory.filePath,
          functionHistory.functionName,
          functionHistory.parentId,
          functionHistory.parentName,
        ],
      })
      .run();
    console.log(`[FuncUndo] New function registered: ${normalizedIdentity.functionName}`);
  }

  return existing[0]?.id || id;
}

export function getAllFunctionsInFile(filePath: string) {
  if (!isDBInitialized()) return [];
  const db = getDrizzleDB();
  const cleanPath = normalizeOSPath(filePath);
  return db.select().from(functionHistory).where(eq(functionHistory.filePath, cleanPath)).all();
}

export function getAllTrackedFunctions() {
  if (!isDBInitialized()) return [];
  const db = getDrizzleDB();
  return db.select().from(functionHistory).all();
}

/**
 * Merges two function histories together (for handling user-confirmed function renames).
 * Reassigns all snapshots, updates dependencies, removes source pointer, and deletes the obsolete function record.
 */
export function mergeFunctionHistories(
  sourceFunctionId: string,
  targetFunctionId: string,
): { mergedSnapshotCount: number } {
  if (sourceFunctionId === targetFunctionId) {
    throw new Error('Cannot merge a function with itself');
  }

  const db = getDrizzleDB();
  const sqlJsDb = getDB();

  const source = db
    .select()
    .from(functionHistory)
    .where(eq(functionHistory.id, sourceFunctionId))
    .get();

  const target = db
    .select()
    .from(functionHistory)
    .where(eq(functionHistory.id, targetFunctionId))
    .get();

  if (!source || !target) {
    throw new Error('Source or target function not found in history');
  }

  sqlJsDb.run('BEGIN TRANSACTION');
  try {
    // 1. Move all snapshots from source to target
    const snapshotsToMove = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.functionHistoryId, sourceFunctionId))
      .all();
    const count = snapshotsToMove.length;

    db.update(snapshots)
      .set({ functionHistoryId: targetFunctionId })
      .where(eq(snapshots.functionHistoryId, sourceFunctionId))
      .run();

    // 2. Re-point any dependencies pointing to source
    db.update(dependencies)
      .set({ dependencyId: targetFunctionId })
      .where(eq(dependencies.dependencyId, sourceFunctionId))
      .run();

    // 3. Remove source pointer
    db.delete(pointers)
      .where(eq(pointers.functionHistoryId, sourceFunctionId))
      .run();

    // 4. Ensure target pointer points to the newest snapshot of the combined history
    const newestSnapshot = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.functionHistoryId, targetFunctionId))
      .orderBy(desc(snapshots.createdAt))
      .get();

    if (newestSnapshot) {
      setPointer(targetFunctionId, newestSnapshot.id);
    }

    // 5. Delete source function record
    db.delete(functionHistory)
      .where(eq(functionHistory.id, sourceFunctionId))
      .run();

    sqlJsDb.run('COMMIT');
    persistDB();

    console.log(
      `[FuncUndo] Merged function ${source.functionName} into ${target.functionName} (${count} snapshots reassigned)`,
    );

    return { mergedSnapshotCount: count };
  } catch (err) {
    sqlJsDb.run('ROLLBACK');
    console.error('[FuncUndo] Function merge failed, rolled back:', err);
    throw err;
  }
}
