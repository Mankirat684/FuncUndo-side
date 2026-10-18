import { eq, desc, inArray } from 'drizzle-orm';
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
 * Returns null if already at the oldest state or if no history exists.
 */
export function getPreviousSnapshot(functionHistoryId: string): SnapshotRecord | null {
  const db = getDrizzleDB();
  const pointerRow = db
    .select()
    .from(pointers)
    .where(eq(pointers.functionHistoryId, functionHistoryId))
    .get();

  const allSnapshots = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.functionHistoryId, functionHistoryId))
    .orderBy(desc(snapshots.createdAt))
    .all();

  if (allSnapshots.length <= 1) return null;

  const currentSnapshotId = pointerRow?.currentSnapshotId || allSnapshots[0].id;
  const currentIndex = allSnapshots.findIndex((s) => s.id === currentSnapshotId);

  if (currentIndex === -1 || currentIndex >= allSnapshots.length - 1) {
    return null; // already at oldest
  }

  return allSnapshots[currentIndex + 1];
}

/**
 * Returns the snapshot immediately following the currently pointed snapshot (for Redo).
 * Returns null if already at the newest state or if no history exists.
 */
export function getNextSnapshot(functionHistoryId: string): SnapshotRecord | null {
  const db = getDrizzleDB();
  const pointerRow = db
    .select()
    .from(pointers)
    .where(eq(pointers.functionHistoryId, functionHistoryId))
    .get();

  if (!pointerRow) return null;

  const allSnapshots = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.functionHistoryId, functionHistoryId))
    .orderBy(desc(snapshots.createdAt))
    .all();

  const currentIndex = allSnapshots.findIndex((s) => s.id === pointerRow.currentSnapshotId);

  if (currentIndex <= 0) {
    return null; // already at newest
  }

  return allSnapshots[currentIndex - 1];
}