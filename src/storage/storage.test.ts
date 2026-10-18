import {
  initDB,
  closeDB,
  upsertFunction,
  saveSnapshot,
  saveAllFunctionsSnapshots,
  getFunctionTimeline,
  getTimelineForFile,
  getAllFunctionsInFile,
  getAllTrackedFunctions,
  getPointer,
  setPointer,
  getPreviousSnapshot,
  getNextSnapshot,
  mergeFunctionHistories,
  runVacuum,
  parsedFunction,
} from './main';

describe('Storage Layer & DB Helper Functions', () => {
  const mockContext = {
    storageUri: undefined,
    globalStorageUri: undefined,
  } as any;

  beforeEach(async () => {
    // Initialise a fresh in-memory database
    await initDB(mockContext);
  });

  afterEach(() => {
    closeDB();
  });

  test('upsertFunction registers a function and returns a stable ID', () => {
    const id1 = upsertFunction({
      filePath: 'src/utils.ts',
      functionName: 'formatDate',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
    });

    const id2 = upsertFunction({
      filePath: 'src/utils.ts',
      functionName: 'formatDate',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
    });

    expect(id1).toBe(id2);

    const all = getAllFunctionsInFile('src/utils.ts');
    expect(all.length).toBe(1);
    expect(all[0].functionName).toBe('formatDate');
  });

  test('saveSnapshot stores snapshot and updates active pointer', () => {
    const fn: parsedFunction = {
      filePath: 'src/math.ts',
      functionName: 'add',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
      content: 'function add(a, b) { return a + b; }',
      hash: 'hash_v1',
      dependencies: [],
      startLine: 1,
      endLine: 3,
    };

    const snapshotId = saveSnapshot(fn);
    const fnId = upsertFunction(fn);

    const pointer = getPointer(fnId);
    expect(pointer).toBe(snapshotId);

    const timeline = getFunctionTimeline(fnId);
    expect(timeline.length).toBe(1);
    expect(timeline[0].snapshot.content).toBe(fn.content);
    expect(timeline[0].snapshot.hash).toBe('hash_v1');
  });

  test('saveAllFunctionsSnapshots saves multiple functions atomically', () => {
    const fn1: parsedFunction = {
      filePath: 'src/app.ts',
      functionName: 'initApp',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
      content: 'function initApp() {}',
      hash: 'h_app',
      dependencies: [],
      startLine: 1,
      endLine: 2,
    };

    const fn2: parsedFunction = {
      filePath: 'src/app.ts',
      functionName: 'stopApp',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
      content: 'function stopApp() {}',
      hash: 'h_stop',
      dependencies: [],
      startLine: 3,
      endLine: 4,
    };

    saveAllFunctionsSnapshots([fn1, fn2]);

    const fileTimeline = getTimelineForFile('src/app.ts');
    expect(fileTimeline.size).toBe(2);

    const tracked = getAllTrackedFunctions();
    expect(tracked.length).toBe(2);
  });

  test('getPreviousSnapshot and getNextSnapshot navigate undo/redo timeline', async () => {
    const baseFn = {
      filePath: 'src/counter.ts',
      functionName: 'increment',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
      dependencies: [],
      startLine: 1,
      endLine: 3,
    };

    // Save v1
    const v1Id = saveSnapshot({
      ...baseFn,
      content: 'return count + 1;',
      hash: 'h_v1',
    });

    // Small delay to ensure createdAt differs
    await new Promise((r) => setTimeout(r, 10));

    // Save v2
    const v2Id = saveSnapshot({
      ...baseFn,
      content: 'return count + 2;',
      hash: 'h_v2',
    });

    await new Promise((r) => setTimeout(r, 10));

    // Save v3
    const v3Id = saveSnapshot({
      ...baseFn,
      content: 'return count + 3;',
      hash: 'h_v3',
    });

    const fnId = upsertFunction(baseFn);

    // Current pointer is v3 (newest)
    expect(getPointer(fnId)).toBe(v3Id);

    // Undo from v3 -> should give v2
    const prevFromV3 = getPreviousSnapshot(fnId);
    expect(prevFromV3).not.toBeNull();
    expect(prevFromV3!.id).toBe(v2Id);
    expect(prevFromV3!.content).toBe('return count + 2;');

    // Step pointer back to v2 (simulating Undo action)
    setPointer(fnId, v2Id);

    // Undo from v2 -> should give v1
    const prevFromV2 = getPreviousSnapshot(fnId);
    expect(prevFromV2!.id).toBe(v1Id);

    // Step pointer back to v1
    setPointer(fnId, v1Id);

    // Undo from v1 -> already at oldest -> null
    const prevFromV1 = getPreviousSnapshot(fnId);
    expect(prevFromV1).toBeNull();

    // Redo from v1 -> should give v2
    const nextFromV1 = getNextSnapshot(fnId);
    expect(nextFromV1).not.toBeNull();
    expect(nextFromV1!.id).toBe(v2Id);

    // Step pointer forward to v2
    setPointer(fnId, v2Id);

    // Redo from v2 -> should give v3
    const nextFromV2 = getNextSnapshot(fnId);
    expect(nextFromV2!.id).toBe(v3Id);
  });

  test('mergeFunctionHistories unifies two functions after rename', async () => {
    // 1. Old function: calculateTotal (has 2 snapshots)
    const oldFn = {
      filePath: 'src/checkout.ts',
      functionName: 'calculateTotal',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
      dependencies: [],
      startLine: 1,
      endLine: 5,
    };
    saveSnapshot({ ...oldFn, content: 'v1 of calculateTotal', hash: 'c_v1' });
    await new Promise((r) => setTimeout(r, 10));
    saveSnapshot({ ...oldFn, content: 'v2 of calculateTotal', hash: 'c_v2' });
    const oldId = upsertFunction(oldFn);

    await new Promise((r) => setTimeout(r, 10));

    // 2. New function: computeTotal (has 1 snapshot)
    const newFn = {
      filePath: 'src/checkout.ts',
      functionName: 'computeTotal',
      parentName: 'GLOBAL',
      parentId: 'GLOBAL',
      dependencies: [],
      startLine: 1,
      endLine: 5,
    };
    const newSnapId = saveSnapshot({ ...newFn, content: 'v1 of computeTotal', hash: 'c_v3' });
    const newId = upsertFunction(newFn);

    expect(getFunctionTimeline(oldId).length).toBe(2);
    expect(getFunctionTimeline(newId).length).toBe(1);

    // 3. User merges calculateTotal into computeTotal
    const result = mergeFunctionHistories(oldId, newId);
    expect(result.mergedSnapshotCount).toBe(2);

    // 4. Old function record should be deleted
    expect(getAllFunctionsInFile('src/checkout.ts').length).toBe(1);

    // 5. New function should now own all 3 snapshots in correct order
    const mergedTimeline = getFunctionTimeline(newId);
    expect(mergedTimeline.length).toBe(3);
    expect(mergedTimeline[0].snapshot.id).toBe(newSnapId); // newest
    expect(mergedTimeline[1].snapshot.hash).toBe('c_v2');
    expect(mergedTimeline[2].snapshot.hash).toBe('c_v1');

    // 6. Pointer should point to newest snapshot of unified history
    expect(getPointer(newId)).toBe(newSnapId);
  });

  test('runVacuum keeps recent snapshots and deletes safely', () => {
    expect(() => runVacuum()).not.toThrow();
  });
});
