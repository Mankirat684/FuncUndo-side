import initSqlJs, { Database } from 'sql.js';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { drizzle } from 'drizzle-orm/sql-js';
import * as schema from './schema';

let sqlJsDb: Database | null = null;
let dbPath: string | null = null;
let db: ReturnType<typeof drizzle<typeof schema>>;

export function isDBInitialized(): boolean {
  return !!db;
}

export function getDrizzleDB(): ReturnType<typeof drizzle<typeof schema>> {
  if (!db) {
    throw new Error('[FuncUndo] DB not initialized — call initDB first');
  }
  return db;
}

export async function initDB(context: vscode.ExtensionContext): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file) => {
      // 1. Same directory (production bundle in dist/)
      const sameDir = path.join(__dirname, file);
      if (fs.existsSync(sameDir)) return sameDir;

      // 2. Dist folder (test/development runtime)
      const distPath = path.join(__dirname, '..', '..', 'dist', file);
      if (fs.existsSync(distPath)) return distPath;

      // 3. node_modules/sql.js
      const nodeModulesPath = path.join(
        __dirname,
        '..',
        '..',
        'node_modules',
        'sql.js',
        'dist',
        file,
      );
      if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;

      return sameDir;
    },
  });

  const storageUri = context.storageUri || context.globalStorageUri;
  const storageDir = storageUri?.fsPath;

  if (storageDir) {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    dbPath = path.join(storageDir, 'funcundo.sqlite');
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      sqlJsDb = new SQL.Database(fileBuffer);
      console.log('[FuncUndo] Existing DB loaded from disk');
    } else {
      sqlJsDb = new SQL.Database();
      console.log('[FuncUndo] New in-memory DB initialized');
    }
  } else {
    sqlJsDb = new SQL.Database();
    console.log('[FuncUndo] In-memory DB initialized (no storage directory)');
  }

  sqlJsDb.run('PRAGMA foreign_keys = ON;');
  db = drizzle(sqlJsDb, { schema });

  runMigrations();
  console.log('[FuncUndo] Drizzle ORM ready');
}

function runMigrations(): void {
  if (!sqlJsDb) return;

  const result = sqlJsDb.exec('PRAGMA user_version');
  const currentVersion = (result[0]?.values[0]?.[0] as number) ?? 0;
  console.log(`[FuncUndo] Schema version: ${currentVersion}`);

  try {
    sqlJsDb.run('BEGIN TRANSACTION');

    if (currentVersion < 1) migrateV1();

    sqlJsDb.run('COMMIT');
  } catch (err) {
    sqlJsDb.run('ROLLBACK');
    console.error('[FuncUndo] Migration failed:', err);
    throw err;
  }
}

function migrateV1(): void {
  if (!sqlJsDb) return;
  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS function_history (
      id            TEXT PRIMARY KEY,
      filePath     TEXT NOT NULL,
      functionName TEXT NOT NULL,
      parentId     TEXT NOT NULL DEFAULT 'GLOBAL',
      parentName   TEXT NOT NULL DEFAULT 'GLOBAL',
      UNIQUE(filePath, functionName, parentId, parentName)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id                  TEXT PRIMARY KEY,
      functionHistoryId   TEXT NOT NULL REFERENCES function_history(id),
      content             TEXT NOT NULL,
      hash                TEXT NOT NULL,
      startLine          INTEGER NOT NULL,
      endLine            INTEGER NOT NULL,
      createdAt          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id              TEXT PRIMARY KEY,
      snapshotId     TEXT NOT NULL REFERENCES snapshots(id),
      dependencyId    TEXT NOT NULL REFERENCES function_history(id),
      type            TEXT NOT NULL CHECK(type IN ('calls', 'calledBy'))
    );

    CREATE TABLE IF NOT EXISTS pointers (
      function_history_id TEXT PRIMARY KEY REFERENCES function_history(id),
      current_snapshot_id TEXT NOT NULL    REFERENCES snapshots(id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_fn
      ON snapshots(functionHistoryId, createdAt);

    CREATE INDEX IF NOT EXISTS idx_dependencies_snapshot
      ON dependencies(snapshotId);

    CREATE INDEX IF NOT EXISTS idx_function_history_filepath
      ON function_history(filePath);  
  `);

  sqlJsDb.run('PRAGMA user_version = 1');
  console.log('[FuncUndo] Migration to v1 completed');
}

export function getDB(): Database {
  if (!sqlJsDb) {
    throw new Error('[FuncUndo] DB not initialized — call initDB first');
  }
  return sqlJsDb;
}

export function persistDB(): void {
  if (!sqlJsDb) {
    throw new Error('[FuncUndo] DB not initialized — call initDB first');
  }
  if (!dbPath) {
    return; // in-memory only (e.g. testing)
  }

  const data = sqlJsDb.export();
  const tempPath = `${dbPath}.tmp`;

  try {
    fs.writeFileSync(tempPath, Buffer.from(data));
    try {
      fs.renameSync(tempPath, dbPath);
    } catch {
      // Windows file replacement fallback
      fs.copyFileSync(tempPath, dbPath);
      fs.unlinkSync(tempPath);
    }
    console.log('[FuncUndo] DB persisted to disk');
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw err;
  }
}

export function closeDB(): void {
  if (sqlJsDb) {
    try {
      persistDB();
    } catch (err) {
      console.error('[FuncUndo] Failed to persist on close:', err);
    }
    sqlJsDb.close();
    sqlJsDb = null;
    dbPath = null;
    console.log('[FuncUndo] DB closed');
  }
}
