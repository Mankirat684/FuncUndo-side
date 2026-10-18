import { eq, asc, inArray } from 'drizzle-orm';
import { getDrizzleDB, getDB,persistDB } from './db';
import { functionHistory, snapshots, dependencies, pointers } from './schema';

export function runVacuum(retentionDays: number = 30, minSnapshotsToKeep: number = 20): void {
  const sqlJsDb = getDB();
  const db = getDrizzleDB();
  if (!sqlJsDb) {
    console.error('Database not initialized');
    return;
  }
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Get all tracked functions
  const allFunctions = db.select().from(functionHistory).all();

  sqlJsDb.run('BEGIN TRANSACTION;');
  try {
    for (const fn of allFunctions) {
      // Get all snapshots oldest → newest
      const allSnapshots = db
        .select()
        .from(snapshots)
        .where(eq(snapshots.functionHistoryId, fn.id))
        .orderBy(asc(snapshots.createdAt))
        .all();

      if (allSnapshots.length <= minSnapshotsToKeep) continue; // nothing to vacuum
      // Always keep at least minSnapshotsToKeep
      const keepIds = allSnapshots.slice(-minSnapshotsToKeep).map((s) => s.id);
      // Delete candidates — outside minSnapshotsToKeep AND older than cutoffTime
      const deleteCandidates = allSnapshots
        .slice(0, -minSnapshotsToKeep)
        .filter((s) => s.createdAt < cutoffTime)
        .map((s) => s.id);
      if (deleteCandidates.length === 0) continue;

    // Delete dependencies first — foreign key constraint
      //   db.delete(dependencies)
      //   .where(inArray(dependencies.snapshotId, deleteCandidates))
      //   .run();
      const pointer = db.select().from(pointers).where(eq(pointers.functionHistoryId, fn.id)).get();
      // Remove pointed snapshot from delete candidates
      const safeToDeleteCandidates = pointer
        ? deleteCandidates.filter((id) => id !== pointer.currentSnapshotId)
        : deleteCandidates;
      if (safeToDeleteCandidates.length === 0) continue;

      // Delete only safe candidates
      db.delete(dependencies).where(inArray(dependencies.snapshotId, safeToDeleteCandidates)).run();

      db.delete(snapshots).where(inArray(snapshots.id, safeToDeleteCandidates)).run();
      console.log(
        `[FuncUndo] Vacuumed ${safeToDeleteCandidates.length} snapshots` +
          ` for ${fn.functionName}, kept ${keepIds.length}`,
      );
    }
    sqlJsDb.run('COMMIT');
    sqlJsDb.run('VACUUM');
    persistDB();
    console.log('[FuncUndo] Vacuum complete');  
  }catch (err) {
    sqlJsDb.run('ROLLBACK');
    console.error('[FuncUndo] Failed to clear function history, rolled back:', err);
    throw err;
  }
}
