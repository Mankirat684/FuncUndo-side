import { eq, desc, asc, inArray, and, lt, gt } from 'drizzle-orm';
import { getDrizzleDB } from './db';
import { snapshots, dependencies, functionHistory, pointers } from './schema';
import type { SnapshotRecord, DependencyRecord, FunctionRecord } from './schema';
import { normalizeOSPath } from '../utils/pathNormalizer';

export interface SnapshotWithDependencies {
  snapshot: SnapshotRecord;
  dependencies: DependencyRecord[];
}

export function getFunctionTimeline(functionHistoryId: string): SnapshotWithDependencies[] {
  const db = getDrizzleDB();
  const snapshotsForFunction = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.functionHistoryId, functionHistoryId))
    .orderBy(desc(snapshots.createdAt))
    .all();

  if (snapshotsForFunction.length === 0) return [];

  const snapshotIds = snapshotsForFunction.map((s) => s.id);
  const allDeps = db
    .select()
    .from(dependencies)
    .where(inArray(dependencies.snapshotId, snapshotIds))
    .all();

  const depMap = new Map<string, DependencyRecord[]>();
  for (const dep of allDeps) {
    const list = depMap.get(dep.snapshotId) || [];
    list.push(dep);
    depMap.set(dep.snapshotId, list);
  }

  return snapshotsForFunction.map((snapshot) => ({
    snapshot,
    dependencies: depMap.get(snapshot.id) || [],
  }));
}

export function getTimelineForFile(filePath: string): Map<string, SnapshotWithDependencies[]> {
  const db = getDrizzleDB();
  const cleanPath = normalizeOSPath(filePath);
  const functionsInFile = db
    .select()
    .from(functionHistory)
    .where(eq(functionHistory.filePath, cleanPath))
    .all();

  if (functionsInFile.length === 0) return new Map();

  const timelineMap = new Map<string, SnapshotWithDependencies[]>();

  for (const func of functionsInFile) {
    const timeline = getFunctionTimeline(func.id);
    timelineMap.set(func.id, timeline);
  }
  return timelineMap;
}

export function getSnapshotById(snapshotId: string): SnapshotWithDependencies | null {
  const db = getDrizzleDB();
  const snapshot = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).get();

  if (!snapshot) return null;

  const dependenciesForSnapshot = db
    .select()
    .from(dependencies)
    .where(eq(dependencies.snapshotId, snapshotId))
    .all();

  return { snapshot, dependencies: dependenciesForSnapshot };
}

export function getLatestSnapshot(functionHistoryId: string): SnapshotWithDependencies | null {
  const db = getDrizzleDB();
  const row = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.functionHistoryId, functionHistoryId))
    .orderBy(desc(snapshots.createdAt))
    .get();

  if (!row) return null;

  const dependenciesForSnapshot = db
    .select()
    .from(dependencies)
    .where(eq(dependencies.snapshotId, row.id))
    .all();

  return {
    snapshot: row,
    dependencies: dependenciesForSnapshot,
  };
}

export function getFunctionById(functionHistoryId: string): FunctionRecord | null {
  const db = getDrizzleDB();
  const row = db
    .select()
    .from(functionHistory)
    .where(eq(functionHistory.id, functionHistoryId))
    .get();

  return row || null;
}

/**
 * Returns the snapshot immediately preceding the currently pointed snapshot (for Undo).
 * Uses true parentSnapshotId ancestry first, falling back to timestamp ordering for legacy records.
 * Returns null if already at the oldest state or if no history exists.
 */
export function getPreviousSnapshot(functionHistoryId: string): SnapshotRecord | null {
  const db = getDrizzleDB();
  const pointerRow = db
    .select()
    .from(pointers)
    .where(eq(pointers.functionHistoryId, functionHistoryId))
    .get();

  const currentSnapshotId = pointerRow?.currentSnapshotId;
  if (!currentSnapshotId) {
    const newest = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.functionHistoryId, functionHistoryId))
      .orderBy(desc(snapshots.createdAt))
      .limit(1)
      .get();
    if (!newest || !newest.parentSnapshotId) return null;
    return (
      db
        .select()
        .from(snapshots)
        .where(eq(snapshots.id, newest.parentSnapshotId))
        .get() ?? null
    );
  }

  const currentSnapshot = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.id, currentSnapshotId))
    .get();

  if (!currentSnapshot) return null;

  // 1. Ancestry lookup: if parentSnapshotId exists, return that parent directly
  if (currentSnapshot.parentSnapshotId) {
    const parent = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, currentSnapshot.parentSnapshotId))
      .get();
    if (parent) return parent;
  }

  // 2. Fallback for legacy snapshots created before parentSnapshotId was introduced:
  const olderSnapshot = db
    .select()
    .from(snapshots)
    .where(
      and(
        eq(snapshots.functionHistoryId, functionHistoryId),
        lt(snapshots.createdAt, currentSnapshot.createdAt),
      ),
    )
    .orderBy(desc(snapshots.createdAt))
    .limit(1)
    .get();

  return olderSnapshot ?? null;
}

/**
 * Returns all child snapshots following the currently pointed snapshot (for Redo / Branch Selection).
 * Uses child branch ancestry (parentSnapshotId) first, falling back to timestamp ordering for legacy records.
 * Returns child branches ordered newest-first (descending createdAt).
 */
export function getNextSnapshots(functionHistoryId: string): SnapshotRecord[] {
  const db = getDrizzleDB();
  const pointerRow = db
    .select()
    .from(pointers)
    .where(eq(pointers.functionHistoryId, functionHistoryId))
    .get();

  if (!pointerRow) return [];

  const currentSnapshot = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.id, pointerRow.currentSnapshotId))
    .get();

  if (!currentSnapshot) return [];

  // 1. Ancestry lookup: find all child snapshots created from this snapshot (latest branch first)
  const childSnapshots = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.parentSnapshotId, currentSnapshot.id))
    .orderBy(desc(snapshots.createdAt))
    .all();

  if (childSnapshots.length > 0) return childSnapshots;

  // 2. Fallback for legacy snapshots without parentSnapshotId:
  const newerSnapshot = db
    .select()
    .from(snapshots)
    .where(
      and(
        eq(snapshots.functionHistoryId, functionHistoryId),
        gt(snapshots.createdAt, currentSnapshot.createdAt),
      ),
    )
    .orderBy(asc(snapshots.createdAt))
    .limit(1)
    .get();

  return newerSnapshot ? [newerSnapshot] : [];
}

/**
 * Returns the latest child snapshot immediately following the currently pointed snapshot (default Redo).
 * Uses child branch ancestry (parentSnapshotId) first, falling back to timestamp ordering for legacy records.
 * Returns null if already at the newest state or if no history exists.
 */
export function getNextSnapshot(functionHistoryId: string): SnapshotRecord | null {
  const nextSnapshots = getNextSnapshots(functionHistoryId);
  return nextSnapshots.length > 0 ? nextSnapshots[0] : null;
}