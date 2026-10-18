import { findFunctionAtCursor, findFunctionByIdentity } from './cursorFinder';
import { ParsedFunction } from '../lib/types';

function createMockFunc(
  name: string,
  startRow: number,
  endRow: number,
  parentName = 'GLOBAL',
  parentId = 'GLOBAL',
): ParsedFunction {
  return {
    name,
    parentName,
    parentId,
    hash: `hash_${name}`,
    range: {
      start: { row: startRow, column: 0 },
      end: { row: endRow, column: 1 },
    },
    rawText: `function ${name}() {}`,
    calls: [],
    isExported: false,
    exportedAs: null,
  };
}

describe('Reversion Engine — Cursor & Scope Resolution', () => {
  test('locates function when cursor is inside body', () => {
    const fn1 = createMockFunc('funcA', 10, 20);
    const fn2 = createMockFunc('funcB', 30, 45);

    const match = findFunctionAtCursor([fn1, fn2], { line: 15, character: 4 });
    expect(match).not.toBeNull();
    expect(match!.name).toBe('funcA');
  });

  test('locates function on boundary start and end lines', () => {
    const fn = createMockFunc('targetFn', 10, 20);

    const startMatch = findFunctionAtCursor([fn], { line: 10, character: 0 });
    expect(startMatch).not.toBeNull();
    expect(startMatch!.name).toBe('targetFn');

    const endMatch = findFunctionAtCursor([fn], { line: 20, character: 1 });
    expect(endMatch).not.toBeNull();
    expect(endMatch!.name).toBe('targetFn');
  });

  test('returns null when cursor is outside any function', () => {
    const fn = createMockFunc('isolatedFn', 10, 20);

    const outsideBefore = findFunctionAtCursor([fn], { line: 5, character: 0 });
    expect(outsideBefore).toBeNull();

    const outsideAfter = findFunctionAtCursor([fn], { line: 25, character: 0 });
    expect(outsideAfter).toBeNull();
  });

  test('selects the innermost function when cursor is inside a nested scope', () => {
    const outerMethod = createMockFunc('handleOrder', 10, 40, 'OrderService', 'OrderService');
    const innerHelper = createMockFunc(
      'computeDiscount',
      20,
      30,
      'handleOrder',
      'OrderService::handleOrder',
    );

    // Cursor at line 25 is inside BOTH handleOrder (10-40) AND computeDiscount (20-30)
    const match = findFunctionAtCursor([outerMethod, innerHelper], { line: 25, character: 5 });

    expect(match).not.toBeNull();
    expect(match!.name).toBe('computeDiscount');
    expect(match!.parentId).toBe('OrderService::handleOrder');
  });

  test('resilient to line-drift after lines are inserted above', () => {
    // Original positions were 10-20, but 30 lines inserted above -> now 40-50
    const driftedFunc = createMockFunc('processPayment', 40, 50);

    // Cursor at line 45 (where the function is NOW, not where snapshot stored it)
    const match = findFunctionAtCursor([driftedFunc], { line: 45, character: 10 });

    expect(match).not.toBeNull();
    expect(match!.name).toBe('processPayment');
  });
});

describe('Reversion Engine — Snapshot Identity Resolution', () => {
  test('locates function strictly by identity matching name and parentId', () => {
    const fn1 = createMockFunc('calculateTotal', 10, 20);
    const fn2 = createMockFunc('validateOrder', 30, 45);

    const match = findFunctionByIdentity([fn1, fn2], {
      functionName: 'calculateTotal',
      parentId: 'GLOBAL',
      parentName: 'GLOBAL',
    });

    expect(match).not.toBeNull();
    expect(match!.name).toBe('calculateTotal');
  });

  test('locates method inside class by parentId', () => {
    const topFn = createMockFunc('save', 10, 20, 'GLOBAL', 'GLOBAL');
    const method = createMockFunc('save', 30, 40, 'UserService', 'UserService');

    const match = findFunctionByIdentity([topFn, method], {
      functionName: 'save',
      parentId: 'UserService',
      parentName: 'UserService',
    });

    expect(match).not.toBeNull();
    expect(match!.name).toBe('save');
    expect(match!.parentId).toBe('UserService');
  });

  test('does not select a different function when target function is absent', () => {
    const fn1 = createMockFunc('calculateTotal', 10, 20);
    const fn2 = createMockFunc('validateOrder', 30, 45);

    // Target function computeTax is not present
    const match = findFunctionByIdentity([fn1, fn2], {
      functionName: 'computeTax',
      parentId: 'GLOBAL',
      parentName: 'GLOBAL',
    });

    expect(match).toBeNull();
  });

  test('falls back gracefully to parentName when parentId does not match directly', () => {
    const method = createMockFunc('process', 10, 20, 'PaymentProcessor', 'PaymentProcessor::v1');

    const match = findFunctionByIdentity([method], {
      functionName: 'process',
      parentName: 'PaymentProcessor',
      parentId: 'PaymentProcessor::v2', // different internal id version
    });

    expect(match).not.toBeNull();
    expect(match!.name).toBe('process');
  });
});
