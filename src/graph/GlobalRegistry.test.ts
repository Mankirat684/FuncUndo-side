import { GlobalSymbolRegistry } from './GlobalRegistry';
import { WorkerParseSuccess, ParsedFunction } from '../lib/types';

function createMockFunction(overrides: Partial<ParsedFunction> = {}): ParsedFunction {
  return {
    name: 'testFn',
    parentName: 'GLOBAL',
    parentId: 'GLOBAL',
    hash: 'hash_123',
    range: { start: { row: 0, column: 0 }, end: { row: 5, column: 0 } },
    rawText: 'function testFn() {}',
    calls: [],
    isExported: false,
    exportedAs: null,
    ...overrides,
  };
}

describe('GlobalSymbolRegistry — Dependency Graph Layer', () => {
  let registry: GlobalSymbolRegistry;

  beforeEach(() => {
    registry = new GlobalSymbolRegistry();
  });

  test('builds intra-file directed edges between caller and callee', () => {
    const fnA = createMockFunction({ name: 'callerFn', calls: ['calleeFn'] });
    const fnB = createMockFunction({ name: 'calleeFn', calls: [] });

    const payload: WorkerParseSuccess = {
      type: 'PARSE_SUCCESS',
      jobId: '1',
      filePath: 'src/main.ts',
      functions: [fnA, fnB],
      fileHash: 'file_hash',
      proxyExports: [],
      wildcardExports: [],
      edges: [{ callerName: 'callerFn', calleeName: 'calleeFn' }],
      imports: [],
      processingTimeMs: 1,
    };

    registry.ingestPayload(payload);
    registry.buildDirectedGraph();

    const callerKey = GlobalSymbolRegistry.generateUUID('src/main.ts', 'callerFn');
    const calleeKey = GlobalSymbolRegistry.generateUUID('src/main.ts', 'calleeFn');

    expect(registry.getDirectCallees(callerKey)).toContain(calleeKey);
    expect(registry.getDirectCallers(calleeKey)).toContain(callerKey);
  });

  test('resolves cross-file imports with firewall matching', () => {
    registry.setFirewall(['c:/project/src/math.ts', 'c:/project/src/app.ts'], {});

    // math.ts exports add
    const mathAdd = createMockFunction({
      name: 'add',
      isExported: true,
      exportedAs: 'add',
    });

    const mathPayload: WorkerParseSuccess = {
      type: 'PARSE_SUCCESS',
      jobId: 'math_1',
      filePath: 'c:/project/src/math.ts',
      functions: [mathAdd],
      fileHash: 'math_hash',
      proxyExports: [],
      wildcardExports: [],
      edges: [],
      imports: [],
      processingTimeMs: 1,
    };

    // app.ts imports add and calls it
    const appMain = createMockFunction({
      name: 'calculate',
      calls: ['add'],
    });

    const appPayload: WorkerParseSuccess = {
      type: 'PARSE_SUCCESS',
      jobId: 'app_1',
      filePath: 'c:/project/src/app.ts',
      functions: [appMain],
      fileHash: 'app_hash',
      proxyExports: [],
      wildcardExports: [],
      edges: [],
      imports: [
        {
          localName: 'add',
          foreignName: 'add',
          rawSource: './math',
        },
      ],
      processingTimeMs: 1,
    };

    registry.ingestPayload(mathPayload);
    registry.ingestPayload(appPayload);
    registry.buildDirectedGraph();

    const appKey = GlobalSymbolRegistry.generateUUID('c:/project/src/app.ts', 'calculate');
    const mathKey = GlobalSymbolRegistry.generateUUID('c:/project/src/math.ts', 'add');

    expect(registry.getDirectCallees(appKey)).toContain(mathKey);
    expect(registry.getDirectCallers(mathKey)).toContain(appKey);
  });

  test('resolves barrel proxy re-exports across files', () => {
    registry.setFirewall(
      ['c:/project/src/math.ts', 'c:/project/src/index.ts', 'c:/project/src/app.ts'],
      {},
    );

    // 1. math.ts has add
    const mathAdd = createMockFunction({
      name: 'add',
      isExported: true,
      exportedAs: 'add',
    });
    registry.ingestPayload({
      type: 'PARSE_SUCCESS',
      jobId: '1',
      filePath: 'c:/project/src/math.ts',
      functions: [mathAdd],
      fileHash: 'h1',
      proxyExports: [],
      wildcardExports: [],
      edges: [],
      imports: [],
      processingTimeMs: 1,
    });

    // 2. index.ts re-exports add from math: export { add } from './math'
    registry.ingestPayload({
      type: 'PARSE_SUCCESS',
      jobId: '2',
      filePath: 'c:/project/src/index.ts',
      functions: [],
      fileHash: 'h2',
      proxyExports: [{ name: 'add', source: './math' }],
      wildcardExports: [],
      edges: [],
      imports: [],
      processingTimeMs: 1,
    });

    // 3. app.ts imports add from index
    const appCompute = createMockFunction({
      name: 'compute',
      calls: ['add'],
    });
    registry.ingestPayload({
      type: 'PARSE_SUCCESS',
      jobId: '3',
      filePath: 'c:/project/src/app.ts',
      functions: [appCompute],
      fileHash: 'h3',
      proxyExports: [],
      wildcardExports: [],
      edges: [],
      imports: [{ localName: 'add', foreignName: 'add', rawSource: './index' }],
      processingTimeMs: 1,
    });

    registry.buildDirectedGraph();

    const appKey = GlobalSymbolRegistry.generateUUID('c:/project/src/app.ts', 'compute');
    const mathKey = GlobalSymbolRegistry.generateUUID('c:/project/src/math.ts', 'add');

    expect(registry.getDirectCallees(appKey)).toContain(mathKey);
  });

  test('calculates deep blast radius with cycle detection and memoization', () => {
    // Chain: D -> C -> B -> A, plus cycle A -> C
    const fnA = createMockFunction({ name: 'fnA', calls: ['fnC'] });
    const fnB = createMockFunction({ name: 'fnB', calls: ['fnA'] });
    const fnC = createMockFunction({ name: 'fnC', calls: ['fnB'] });
    const fnD = createMockFunction({ name: 'fnD', calls: ['fnC'] });

    registry.ingestPayload({
      type: 'PARSE_SUCCESS',
      jobId: 'cycle',
      filePath: 'src/cycle.ts',
      functions: [fnA, fnB, fnC, fnD],
      fileHash: 'cycle_h',
      proxyExports: [],
      wildcardExports: [],
      edges: [],
      imports: [],
      processingTimeMs: 1,
    });

    registry.buildDirectedGraph();

    // Query blast radius of fnA: who calls fnA directly or indirectly?
    const risk = registry.computeRiskAnalysis('src/cycle.ts', 'fnA');

    // fnB calls fnA, fnC calls fnB, fnD calls fnC -> all three are impacted!
    expect(risk.dependents.length).toBe(3);
    expect(risk.level).toBe('WARNING'); // <= 3 dependents
  });

  test('differentiates methods in different classes using parentId', () => {
    const methodA = createMockFunction({
      name: 'render',
      parentName: 'Header',
      parentId: 'Header',
      calls: [],
    });

    const methodB = createMockFunction({
      name: 'render',
      parentName: 'Footer',
      parentId: 'Footer',
      calls: [],
    });

    registry.ingestPayload({
      type: 'PARSE_SUCCESS',
      jobId: 'classes',
      filePath: 'src/components.ts',
      functions: [methodA, methodB],
      fileHash: 'comp_h',
      proxyExports: [],
      wildcardExports: [],
      edges: [],
      imports: [],
      processingTimeMs: 1,
    });

    registry.buildDirectedGraph();

    const headerKey = GlobalSymbolRegistry.generateUUID('src/components.ts', 'render', 'Header');
    const footerKey = GlobalSymbolRegistry.generateUUID('src/components.ts', 'render', 'Footer');

    expect(headerKey).not.toEqual(footerKey);
    expect(registry.getNode(headerKey)).not.toBeNull();
    expect(registry.getNode(footerKey)).not.toBeNull();
  });
});
