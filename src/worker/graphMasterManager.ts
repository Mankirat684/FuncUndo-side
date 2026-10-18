// src/worker/graphMasterManager.ts
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  GraphMasterQueryMessage,
  GraphMasterQueryResponse,
  WorkerParseSuccess,
} from '../lib/types';

export class GraphMasterManager {
  private worker: Worker | null = null;
  private pendingQueries = new Map<
    string,
    {
      resolve: (value: GraphMasterQueryResponse) => void;
      reject: (reason?: any) => void;
    }
  >();

  constructor(private extensionPath: string) {}

  public init(): void {
    const workerPath = path.join(this.extensionPath, 'dist', 'worker', 'graphMaster.worker.js');
    this.worker = new Worker(workerPath);

    this.worker.on('message', (message: any) => {
      if (message.type === 'QUERY_BLAST_RADIUS_RESPONSE') {
        const pending = this.pendingQueries.get(message.queryId);
        if (pending) {
          pending.resolve(message);
          this.pendingQueries.delete(message.queryId);
        }
      }
    });

    this.worker.on('error', (err) => {
      console.error('[GraphMasterManager] Fatal error:', err);
      for (const [, query] of this.pendingQueries.entries()) {
        query.reject(err);
      }
      this.pendingQueries.clear();
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[GraphMasterManager] Worker stopped with exit code ${code}`);
      }
    });
  }

  public on(event: string, listener: (...args: any[]) => void): void {
    this.worker?.on(event, listener);
  }

  public postMessage(message: any): void {
    this.worker?.postMessage(message);
  }

  public updateFirewall(validFiles: string[], aliases: Record<string, string> = {}): void {
    this.postMessage({
      type: 'UPDATE_FIREWALL',
      validFiles,
      aliases,
    });
  }

  public ingestPayload(payload: WorkerParseSuccess): void {
    this.postMessage({
      type: 'INGEST_PAYLOAD',
      payload,
    });
  }

  public async queryBlastRadius(
    targetURI: string,
    functionName: string,
    parentId?: string,
  ): Promise<GraphMasterQueryResponse> {
    if (!this.worker) {
      throw new Error('GraphMasterManager is not initialized');
    }

    const queryId = crypto.randomUUID();
    const queryMessage: GraphMasterQueryMessage = {
      type: 'QUERY_BLAST_RADIUS',
      queryId,
      targetURI,
      functionName,
      parentId,
    };

    return new Promise((resolve, reject) => {
      this.pendingQueries.set(queryId, { resolve, reject });
      this.worker!.postMessage(queryMessage);
    });
  }

  public dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
