import { parentPort } from 'worker_threads';
import { GlobalSymbolRegistry } from '../graph/GlobalRegistry';
import { GraphMasterIncoming } from '../lib/types';

if (!parentPort) {
  throw new Error('Fatal: graphMaster.worker.ts must be run as a Node.js Worker thread.');
}


console.log('[Graph Master] Booting Immortal State Worker...');

const globalRegistry = new GlobalSymbolRegistry();

parentPort.on('message', (message: GraphMasterIncoming) => {
  try {
    if (message.type === 'UPDATE_FIREWALL') {
      globalRegistry.setFirewall(message.validFiles, message.aliases);
      console.log(`[Graph Master] RAM Firewall synced: ${message.validFiles.length} files.`);
    }

    if (message.type === 'INGEST_PAYLOAD') {
      globalRegistry.ingestPayload(message.payload);
      globalRegistry.buildDirectedGraph();
    }

    if (message.type === 'QUERY_BLAST_RADIUS') {
      const { queryId, targetURI, functionName, parentId } = message;
      const risk = globalRegistry.computeRiskAnalysis(targetURI, functionName, parentId);

      parentPort?.postMessage({
        type: 'QUERY_BLAST_RADIUS_RESPONSE',
        queryId,
        blastRadiusCount: risk.dependentCount,
        impactedFunctions: risk.dependents,
        level: risk.level,
      });
    }

    if (message.type === 'GET_FULL_GRAPH') {
      const data = globalRegistry.exportGraph();
      parentPort?.postMessage({
        type: 'GET_FULL_GRAPH_RESPONSE',
        queryId: message.queryId,
        data,
      });
    }
  } catch (error) {
    console.error('[Graph Master Internal Error]', error);
  }
});
