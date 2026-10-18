import type { SyntaxNode } from 'web-tree-sitter';
import { ParsedFunction } from '../lib/types';
import { generateStructuralHash } from './semanticHasher';
import { ImportedSymbol } from '../lib/types';

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'arrow_function',
  'method_definition',
  'function_expression',
  'generator_function',
]);

function getEffectiveParent(node: SyntaxNode): SyntaxNode | null {
  let curr = node.parent;
  while (
    curr &&
    (curr.type === 'parenthesized_expression' ||
      curr.type === 'as_expression' ||
      curr.type === 'type_assertion' ||
      curr.type === 'non_null_expression')
  ) {
    curr = curr.parent;
  }
  return curr;
}

export function extractFunctionName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  const effectiveParent = getEffectiveParent(node);
  if (!effectiveParent) return null;

  // Handle variable declarations: const foo = () => {}, let bar = function() {}
  if (effectiveParent.type === 'variable_declarator') {
    const idNode = effectiveParent.childForFieldName('name');
    if (idNode) return idNode.text;
  }

  // Handle object property assignment: const obj = { myFn: () => {} }
  if (effectiveParent.type === 'pair') {
    const keyNode = effectiveParent.childForFieldName('key');
    if (keyNode) return keyNode.text;
  }

  // Handle class fields / property definitions: class Foo { bar = () => {} }
  if (
    effectiveParent.type === 'field_definition' ||
    effectiveParent.type === 'public_field_definition' ||
    effectiveParent.type === 'property_definition'
  ) {
    const propNode =
      effectiveParent.childForFieldName('property') || effectiveParent.childForFieldName('name');
    if (propNode) return propNode.text;
  }

  // Handle assignments: Foo.prototype.bar = function() {}, exports.bar = () => {}
  if (effectiveParent.type === 'assignment_expression') {
    const leftNode = effectiveParent.childForFieldName('left');
    if (leftNode) {
      if (leftNode.type === 'member_expression') {
        const propNode = leftNode.childForFieldName('property');
        if (propNode) return propNode.text;
      }
      return leftNode.text;
    }
  }

  // Handle export default function / arrow
  if (effectiveParent.type === 'export_statement') {
    return 'default';
  }

  // Inline callback arguments (e.g. .map(), setTimeout, relations()) are not tracked functions
  return null;
}

export function extractScopeChain(node: SyntaxNode): string[] {
  const scopes: string[] = [];
  let curr = node.parent;

  while (curr) {
    if (curr.type === 'class_declaration') {
      const className = curr.childForFieldName('name')?.text;
      scopes.unshift(className || 'AnonymousClass');
    } else if (curr.type === 'class_expression') {
      const parentDeclarator = curr.parent?.type === 'variable_declarator' ? curr.parent : null;
      const className = parentDeclarator?.childForFieldName('name')?.text || 'AnonymousClass';
      scopes.unshift(className);
    } else if (FUNCTION_TYPES.has(curr.type)) {
      const funcName = extractFunctionName(curr);
      if (funcName) {
        scopes.unshift(funcName);
      }
    } else if (curr.type === 'object') {
      if (curr.parent?.type === 'variable_declarator') {
        const objName = curr.parent.childForFieldName('name')?.text;
        if (objName) {
          scopes.unshift(objName);
        }
      } else if (curr.parent?.type === 'assignment_expression') {
        const left = curr.parent.childForFieldName('left');
        if (left) {
          scopes.unshift(left.text);
        }
      }
    }
    curr = curr.parent;
  }

  return scopes;
}

export function extractParentInfo(node: SyntaxNode): { parentName: string; parentId: string } {
  const scopes = extractScopeChain(node);
  if (scopes.length === 0) {
    return { parentName: 'GLOBAL', parentId: 'GLOBAL' };
  }
  const parentName = scopes[scopes.length - 1];
  const parentId = scopes.join('::');
  return { parentName, parentId };
}

function resolveCallTarget(calleeNode: SyntaxNode): string | null {
  let currentNode = calleeNode;

  if (currentNode.type === 'optional_chain') {
    const unwrapped = currentNode.firstNamedChild;
    if (!unwrapped) return null;
    currentNode = unwrapped;
  }

  if (currentNode.type === 'identifier') {
    return currentNode.text;
  }

  if (currentNode.type === 'member_expression') {
    const propertyNode = currentNode.childForFieldName('property');
    // If the object itself is a call (getAuth().login), the continuous recursion
    // will catch getAuth, so we just want the rightmost leaf (login).
    if (propertyNode && propertyNode.type === 'property_identifier') {
      return propertyNode.text;
    }
  }

  if (currentNode.type === 'subscript_expression') {
    const indexNode = currentNode.childForFieldName('index');

    // ONLY extract if it is a hardcoded string.
    // Dynamic properties (obj[propName]) are gracefully ignored.
    if (indexNode && indexNode.type === 'string') {
      return indexNode.text.replace(/['"`]/g, '');
    }
  }

  return null;
}

/**
 * Scans STRICTLY inside a function's syntax tree to find execution calls.
 * Returns a deduplicated array of the names of the functions being called.
 */
function extractInternalCalls(functionNode: SyntaxNode): string[] {
  const dependencies = new Set<string>();

  function walkBody(node: SyntaxNode) {
    if (FUNCTION_TYPES.has(node.type)) {
      return;
    }

    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      if (callee) {
        const targetName = resolveCallTarget(callee);
        if (targetName) {
          dependencies.add(targetName); // Map EVERYTHING for now
        }
      }
    }

    // We MUST keep walking the children to catch foo(bar()) where bar()
    // is hidden inside the arguments array of foo().
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkBody(child);
    }
  }

  // Start the walk ONLY on the body to prevent the root node from instantly
  // triggering the Circuit Breaker and killing the scan.
  const bodyNode = functionNode.childForFieldName('body');

  if (bodyNode) {
    walkBody(bodyNode);
  } else {
    // Arrow functions with implicit returns (e.g., const x = () => foo(bar()))
    // Their children are the direct expressions.
    for (let i = 0; i < functionNode.childCount; i++) {
      const child = functionNode.child(i);
      if (child) walkBody(child);
    }
  }

  return Array.from(dependencies);
}

//DFS( MAIN FUNCTION )
export function extractFunctions(
  rootNode: SyntaxNode,
  resolvedImports: ImportedSymbol[],
): ParsedFunction[] {
  const results: ParsedFunction[] = [];

  function walk(node: SyntaxNode) {
    if (node.isNamed && FUNCTION_TYPES.has(node.type)) {
      const funcName = extractFunctionName(node);
      if (funcName) {
        const { parentName, parentId } = extractParentInfo(node);

        const parsedFunc: ParsedFunction = {
          name: funcName,
          parentName,
          parentId,
          hash: generateStructuralHash(node),
          range: {
            start: { row: node.startPosition.row, column: node.startPosition.column },
            end: { row: node.endPosition.row, column: node.endPosition.column },
          },
          rawText: node.text,
          calls: extractInternalCalls(node),
          isExported: false, // default, may be updated later by exportResolver
          exportedAs: null, // default, may be updated later by exportResolver
        };
        results.push(parsedFunc);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        walk(child);
      }
    }
  }

  walk(rootNode); //RECURSION TRIGGER

  const validSignatures = new Set([
    ...results.map((f) => f.name),
    ...resolvedImports.map((imp) => imp.localName),
  ]);

  for (const func of results) {
    const purifiedCalls: string[] = [];
    for (const rawCall of func.calls) {
      // Now 'calc' will pass this check!
      if (validSignatures.has(rawCall)) {
        purifiedCalls.push(rawCall);
      }
    }
    func.calls = purifiedCalls;
  }

  return results;
}
