import { ParsedFunction } from '../lib/types';

/**
 * Finds the innermost function enclosing the cursor position.
 * Handles nested functions, arrow functions, and class methods.
 * Independent of VS Code runtime for 100% testability.
 */
export function findFunctionAtCursor(
  functions: ParsedFunction[],
  cursor: { line: number; character: number },
): ParsedFunction | null {
  const matchingFunctions: ParsedFunction[] = [];

  for (const fn of functions) {
    const startRow = fn.range.start.row;
    const endRow = fn.range.end.row;
    const startCol = fn.range.start.column;
    const endCol = fn.range.end.column;

    // Check row bounds
    if (cursor.line < startRow || cursor.line > endRow) {
      continue;
    }

    // Check column bounds on boundary lines
    if (cursor.line === startRow && cursor.character < startCol) {
      continue;
    }
    if (cursor.line === endRow && cursor.character > endCol) {
      continue;
    }

    matchingFunctions.push(fn);
  }

  if (matchingFunctions.length === 0) {
    return null;
  }

  // If nested (e.g. inner helper inside outer function), pick innermost (smallest row span)
  matchingFunctions.sort((a, b) => {
    const spanA = a.range.end.row - a.range.start.row;
    const spanB = b.range.end.row - b.range.start.row;
    if (spanA !== spanB) {
      return spanA - spanB; // smaller span first
    }
    // Tie-breaker: higher start row (more deeply nested)
    return b.range.start.row - a.range.start.row;
  });

  return matchingFunctions[0];
}

export interface FunctionTargetIdentity {
  functionName: string;
  parentName?: string | null;
  parentId?: string | null;
}

/**
 * Resolves a function strictly by identity (name, parentName, parentId).
 * Completely decoupled from editor cursor position and independent of VS Code runtime.
 */
export function findFunctionByIdentity(
  functions: ParsedFunction[],
  identity: FunctionTargetIdentity,
): ParsedFunction | null {
  const normParentName = identity.parentName || 'GLOBAL';
  const normParentId = identity.parentId || 'GLOBAL';

  // 1. Strict match on name + parentId
  let match = functions.find(
    (f) => f.name === identity.functionName && (f.parentId || 'GLOBAL') === normParentId,
  );
  if (match) return match;

  // 2. Fallback match on name + parentName
  match = functions.find(
    (f) => f.name === identity.functionName && (f.parentName || 'GLOBAL') === normParentName,
  );
  if (match) return match;

  // 3. Fallback match on name only if parentName is GLOBAL or unspecified
  if (normParentName === 'GLOBAL') {
    match = functions.find(
      (f) => f.name === identity.functionName && (!f.parentName || f.parentName === 'GLOBAL'),
    );
    if (match) return match;
  }

  return null;
}
