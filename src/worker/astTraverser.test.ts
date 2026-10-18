import Parser from 'web-tree-sitter';
import * as path from 'path';
import { extractFunctions } from './astTraverser';

describe('AST Traverser — Parent Scope Extraction', () => {
  let parser: Parser;

  beforeAll(async () => {
    const runtimeWasm = path.join(__dirname, '..', 'wasm', 'tree-sitter.wasm');
    await Parser.init({
      locateFile() {
        return runtimeWasm;
      },
    });

    parser = new Parser();
    const langWasm = path.join(__dirname, '..', 'wasm', 'tree-sitter-javascript.wasm');
    const JavaScript = await Parser.Language.load(langWasm);
    parser.setLanguage(JavaScript);
  });

  test('extracts top-level function as parent GLOBAL', () => {
    const code = `
      function topLevel(x) {
        return x + 1;
      }
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    expect(functions.length).toBe(1);
    expect(functions[0].name).toBe('topLevel');
    expect(functions[0].parentName).toBe('GLOBAL');
    expect(functions[0].parentId).toBe('GLOBAL');
  });

  test('extracts class method with parentName as class name and parentId as class name', () => {
    const code = `
      class AuthService {
        login(username, password) {
          return true;
        }
      }
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    expect(functions.length).toBe(1);
    expect(functions[0].name).toBe('login');
    expect(functions[0].parentName).toBe('AuthService');
    expect(functions[0].parentId).toBe('AuthService');
  });

  test('extracts nested function inside method with hierarchical parentId', () => {
    const code = `
      class OrderService {
        processOrder() {
          const calculateTax = (amount) => {
            return amount * 0.1;
          };
          return calculateTax(100);
        }
      }
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    const processOrder = functions.find((f) => f.name === 'processOrder');
    const calculateTax = functions.find((f) => f.name === 'calculateTax');

    expect(processOrder).toBeDefined();
    expect(processOrder!.parentName).toBe('OrderService');
    expect(processOrder!.parentId).toBe('OrderService');

    expect(calculateTax).toBeDefined();
    expect(calculateTax!.parentName).toBe('processOrder');
    expect(calculateTax!.parentId).toBe('OrderService::processOrder');
  });

  test('extracts functions in object literals with parentName as object name', () => {
    const code = `
      const mathOps = {
        multiply(a, b) {
          return a * b;
        }
      };
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    expect(functions.length).toBe(1);
    expect(functions[0].name).toBe('multiply');
    expect(functions[0].parentName).toBe('mathOps');
    expect(functions[0].parentId).toBe('mathOps');
  });

  test('extracts nested function inside top-level function', () => {
    const code = `
      function outer() {
        function inner() {
          return 42;
        }
        return inner();
      }
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    const outerFn = functions.find((f) => f.name === 'outer');
    const innerFn = functions.find((f) => f.name === 'inner');

    expect(outerFn).toBeDefined();
    expect(outerFn!.parentName).toBe('GLOBAL');
    expect(outerFn!.parentId).toBe('GLOBAL');

    expect(innerFn).toBeDefined();
    expect(innerFn!.parentName).toBe('outer');
    expect(innerFn!.parentId).toBe('outer');
  });

  test('ignores unassigned inline callbacks (e.g. .map, setTimeout, relations helpers)', () => {
    const code = `
      export function processItems(items) {
        return items.map((item) => item.id).filter((id) => id !== null);
      }

      setTimeout(() => {
        console.log('timeout fired');
      }, 1000);
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    // Only processItems should be extracted — the inline callbacks in .map, .filter, setTimeout must NOT be extracted
    expect(functions.length).toBe(1);
    expect(functions[0].name).toBe('processItems');
  });

  test('extracts arrow functions assigned to variables and class fields', () => {
    const code = `
      export const calculateSum = (a, b) => a + b;

      class Calculator {
        multiply = (a, b) => a * b;
      }

      exports.divide = function(a, b) { return a / b; };
    `;
    const tree = parser.parse(code);
    const functions = extractFunctions(tree.rootNode, []);

    const names = functions.map((f) => f.name);
    expect(names).toContain('calculateSum');
    expect(names).toContain('multiply');
    expect(names).toContain('divide');
  });
});

