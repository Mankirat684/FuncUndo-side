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
