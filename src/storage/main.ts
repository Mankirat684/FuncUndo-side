// Storage layer public API
// All other phases import from here, never from individual files

// DB lifecycle
export { initDB, persistDB, closeDB, getDB, getDrizzleDB } from './db';

// Write
export { saveSnapshot, saveAllFunctionsSnapshots } from './snapshots';
export {
  upsertFunction,
  getAllFunctionsInFile,
  getAllTrackedFunctions,
  generateFunctionId,
  mergeFunctionHistories,
} from './functions';

// Read
export {
  getFunctionTimeline,
  getTimelineForFile,
  getSnapshotById,
  getLatestSnapshot,
  getFunctionById,
  getPreviousSnapshot,
  getNextSnapshot,
  getNextSnapshots,
} from './reads';

// Pointer management
export { setPointer, getPointer, deletePointer } from './pointer';

// Maintenance
export { runVacuum } from './maintenance';

// Types — other phases need these
export type { parsedFunction } from './snapshots';
export type { functionIdentity } from './functions';
export type {
  FunctionRecord,
  NewFunction,
  SnapshotRecord,
  NewSnapshot,
  DependencyRecord,
  NewDependency,
  PointerRecord,
  NewPointer,
} from './schema';
export type { SnapshotWithDependencies } from './reads';
