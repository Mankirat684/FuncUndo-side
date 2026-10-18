import {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
  GraphNode,
  ImportedSymbol,
  ParsedFunction,
  ProxyExport,
  RiskAnalysisResult,
  RiskLevel,
  WorkerParseSuccess,
} from '../lib/types';
import { normalizeOSPath } from '../utils/pathNormalizer';
import { resolveAbsoluteURI } from '../utils/uriResolver';

export interface OptimizedFileRecord {
  fileURI: string;
  functions: ParsedFunction[];
  localFunctionMap: Map<string, ParsedFunction>; // Key: local function name or qualified name
  importMap: Map<string, ImportedSymbol>; // Key: local alias name
  proxyExports: ProxyExport[];
  wildcardExports: string[];
}

export class GlobalSymbolRegistry {
  // 1. The Raw Data Store
  private fileRegistry = new Map<string, OptimizedFileRecord>();

  // 2. The Bidirectional Relational Graph
  private directedGraph = new Map<string, GraphNode>();

  private validWorkspaceFiles = new Set<string>();
  private aliases: Record<string, string> = {};

  public ingestPayload(payload: WorkerParseSuccess): void {
    const normalizedURI = normalizeOSPath(payload.filePath);

    const localFunctionMap = new Map<string, ParsedFunction>();
    for (const func of payload.functions) {
      if (func.parentId && func.parentId !== 'GLOBAL') {
        localFunctionMap.set(`${func.parentId}::${func.name}`, func);
      }
      localFunctionMap.set(func.name, func);
    }

    const importMap = new Map<string, ImportedSymbol>();
    for (const imp of payload.imports) {
      importMap.set(imp.localName, imp);
    }

    this.fileRegistry.set(normalizedURI, {
      fileURI: normalizedURI,
      functions: payload.functions,
      localFunctionMap,
      importMap,
      proxyExports: payload.proxyExports || [],
      wildcardExports: payload.wildcardExports || [],
    });
  }

  public static generateUUID(
    normalizedURI: string,
    functionName: string,
    parentId: string = 'GLOBAL',
  ): string {
    const cleanURI = normalizeOSPath(normalizedURI);
    if (parentId && parentId !== 'GLOBAL') {
      return `${cleanURI}::${parentId}::${functionName}`;
    }
    return `${cleanURI}::${functionName}`;
  }

  /**
   * Resolves an exported symbol from targetURI.
   * Handles local exports, proxy pass-through exports, and wildcard exports.
   */
  public resolveExport(
    targetURI: string,
    foreignName: string,
    visited: Set<string> = new Set(),
  ): { uri: string; name: string; parentId: string } | null {
    const normalizedURI = normalizeOSPath(targetURI);
    if (visited.has(normalizedURI)) return null;
    visited.add(normalizedURI);

    const fileRecord = this.fileRegistry.get(normalizedURI);
    if (!fileRecord) return null;

    // 1. Direct local exports
    for (const f of fileRecord.functions) {
      if (
        f.isExported &&
        (f.exportedAs === foreignName ||
          f.name === foreignName ||
          (foreignName === 'default' && f.exportedAs === 'default'))
      ) {
        return { uri: normalizedURI, name: f.name, parentId: f.parentId || 'GLOBAL' };
      }
    }

    // 2. Proxy re-exports (export { foo as bar } from './source')
    for (const proxy of fileRecord.proxyExports) {
      if (proxy.name === foreignName) {
        const resolvedProxyURI = resolveAbsoluteURI(
          normalizedURI,
          proxy.source,
          this.validWorkspaceFiles,
          this.aliases,
        );
        if (resolvedProxyURI) {
          const match = this.resolveExport(resolvedProxyURI, foreignName, visited);
          if (match) return match;
        }
      }
    }

    // 3. Wildcard re-exports (export * from './source')
    for (const wildcardSource of fileRecord.wildcardExports) {
      const resolvedWildcardURI = resolveAbsoluteURI(
        normalizedURI,
        wildcardSource,
        this.validWorkspaceFiles,
        this.aliases,
      );
      if (resolvedWildcardURI) {
        const match = this.resolveExport(resolvedWildcardURI, foreignName, visited);
        if (match) return match;
      }
    }

    return null;
  }

  public buildDirectedGraph(): void {
    this.directedGraph.clear();

    // 1. Ensure a node exists for every tracked function
    for (const [callerURI, fileRecord] of this.fileRegistry.entries()) {
      for (const func of fileRecord.functions) {
        const callerKey = GlobalSymbolRegistry.generateUUID(callerURI, func.name, func.parentId);
        if (!this.directedGraph.has(callerKey)) {
          this.directedGraph.set(callerKey, {
            outboundEdges: new Set(),
            inboundEdges: new Set(),
            deepInboundCache: null,
          });
        }
      }
    }

    // 2. Build directional edges caller → callee
    for (const [callerURI, fileRecord] of this.fileRegistry.entries()) {
      for (const func of fileRecord.functions) {
        const callerKey = GlobalSymbolRegistry.generateUUID(callerURI, func.name, func.parentId);
        const callerNode = this.directedGraph.get(callerKey)!;

        for (const callName of func.calls) {
          let targetKey: string | null = null;

          // Case 1: Intra-file call within same parent scope
          if (func.parentId && func.parentId !== 'GLOBAL') {
            const scopedMatch = fileRecord.localFunctionMap.get(`${func.parentId}::${callName}`);
            if (scopedMatch) {
              targetKey = GlobalSymbolRegistry.generateUUID(
                callerURI,
                scopedMatch.name,
                scopedMatch.parentId,
              );
            }
          }

          // Case 2: Intra-file call anywhere in file
          if (!targetKey && fileRecord.localFunctionMap.has(callName)) {
            const localMatch = fileRecord.localFunctionMap.get(callName)!;
            targetKey = GlobalSymbolRegistry.generateUUID(
              callerURI,
              localMatch.name,
              localMatch.parentId,
            );
          }

          // Case 3: Cross-file call via import
          else if (!targetKey && fileRecord.importMap.has(callName)) {
            const importRecord = fileRecord.importMap.get(callName)!;
            const targetURI = resolveAbsoluteURI(
              callerURI,
              importRecord.rawSource,
              this.validWorkspaceFiles,
              this.aliases,
            );

            if (targetURI) {
              const resolved = this.resolveExport(targetURI, importRecord.foreignName);
              if (resolved) {
                targetKey = GlobalSymbolRegistry.generateUUID(
                  resolved.uri,
                  resolved.name,
                  resolved.parentId,
                );
              }
            }
          }

          if (targetKey) {
            if (!this.directedGraph.has(targetKey)) {
              this.directedGraph.set(targetKey, {
                outboundEdges: new Set(),
                inboundEdges: new Set(),
                deepInboundCache: null,
              });
            }

            callerNode.outboundEdges.add(targetKey);
            const targetNode = this.directedGraph.get(targetKey)!;
            targetNode.inboundEdges.add(callerKey);
            targetNode.deepInboundCache = null;
          }
        }
      }
    }

    console.log(`[GlobalRegistry] Directed graph built: ${this.directedGraph.size} nodes.`);
  }

  public setFirewall(validFiles: string[], aliases: Record<string, string>): void {
    this.validWorkspaceFiles = new Set(validFiles.map((f) => normalizeOSPath(f)));
    this.aliases = aliases;
  }

  public getNode(uuid: string): GraphNode | null {
    return this.directedGraph.get(uuid) || null;
  }

  public getDirectedGraph(): Map<string, GraphNode> {
    return this.directedGraph;
  }

  public getRegistrySize(): number {
    return this.fileRegistry.size;
  }

  public getDirectCallers(key: string): string[] {
    const node = this.directedGraph.get(key);
    return node ? Array.from(node.inboundEdges) : [];
  }

  public getDirectCallees(key: string): string[] {
    const node = this.directedGraph.get(key);
    return node ? Array.from(node.outboundEdges) : [];
  }

  /**
   * Deep transitive dependencies (what does this function call downstream?)
   */
  public getDependencies(startKey: string, visited: Set<string> = new Set()): Set<string> {
    if (visited.has(startKey)) return visited;
    visited.add(startKey);

    const node = this.directedGraph.get(startKey);
    if (!node) return visited;

    for (const dep of node.outboundEdges) {
      this.getDependencies(dep, visited);
    }
    return visited;
  }

  /**
   * Deep blast radius / impacted functions (who calls this function upstream?)
   */
  public getImpactedFunctions(startKey: string, visited: Set<string> = new Set()): Set<string> {
    if (visited.has(startKey)) return visited;

    const node = this.directedGraph.get(startKey);
    if (!node) {
      visited.add(startKey);
      return visited;
    }

    if (node.deepInboundCache !== null) {
      for (const cached of node.deepInboundCache) {
        visited.add(cached);
      }
      return visited;
    }

    visited.add(startKey);

    for (const caller of node.inboundEdges) {
      this.getImpactedFunctions(caller, visited);
    }

    node.deepInboundCache = new Set(visited);
    return visited;
  }

  /**
   * Calculates the full risk profile and dependent list for a target function.
   */
  public computeRiskAnalysis(
    targetURI: string,
    functionName: string,
    parentId: string = 'GLOBAL',
  ): RiskAnalysisResult {
    const uuid = GlobalSymbolRegistry.generateUUID(targetURI, functionName, parentId);
    const impacted = this.getImpactedFunctions(uuid);

    // Remove self from dependents count
    impacted.delete(uuid);

    const dependentCount = impacted.size;
    const level: RiskLevel =
      dependentCount === 0 ? 'SAFE' : dependentCount <= 3 ? 'WARNING' : 'DANGER';

    return {
      targetFunction: functionName,
      level,
      dependentCount,
      dependents: Array.from(impacted),
    };
  }

  /**
   * Serializes the full directed function dependency graph for the UI.
   */
  public exportGraph(): DependencyGraphData {
    const nodeMap = new Map<string, DependencyGraphNode>();

    for (const [fileURI, fileRecord] of this.fileRegistry.entries()) {
      for (const func of fileRecord.functions) {
        const id = GlobalSymbolRegistry.generateUUID(fileURI, func.name, func.parentId);
        const risk = this.computeRiskAnalysis(fileURI, func.name, func.parentId);
        nodeMap.set(id, {
          id,
          name: func.name,
          parentId: func.parentId || 'GLOBAL',
          parentName: func.parentName || 'GLOBAL',
          filePath: fileURI,
          startLine: func.range.start.row,
          endLine: func.range.end.row,
          riskLevel: risk.level,
          blastRadiusCount: risk.dependentCount,
          impactedFunctions: risk.dependents,
        });
      }
    }

    for (const key of this.directedGraph.keys()) {
      if (!nodeMap.has(key)) {
        const parts = key.split('::');
        const filePath = parts[0] || '';
        const parentId = parts.length > 2 ? parts[1] : 'GLOBAL';
        const name = parts.length > 2 ? parts[2] : parts[1] || key;
        const risk = this.computeRiskAnalysis(filePath, name, parentId);
        nodeMap.set(key, {
          id: key,
          name,
          parentId,
          parentName: parentId,
          filePath,
          startLine: 0,
          endLine: 0,
          riskLevel: risk.level,
          blastRadiusCount: risk.dependentCount,
          impactedFunctions: risk.dependents,
        });
      }
    }

    const edges: DependencyGraphEdge[] = [];
    const edgeSet = new Set<string>();

    for (const [sourceId, node] of this.directedGraph.entries()) {
      for (const targetId of node.outboundEdges) {
        const edgeKey = `${sourceId}->${targetId}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            source: sourceId,
            target: targetId,
          });
        }
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges,
    };
  }
}

