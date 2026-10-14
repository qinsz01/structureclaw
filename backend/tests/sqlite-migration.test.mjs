import { test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyPreservingMigration } from '../scripts/sqlite-migration.mjs';

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-db-migration-'));
  const file = path.join(dir, 'user.sqlite');
  try { fn(file); } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sclaw-db-migration-')) throw new Error('Invalid fixture');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function initialize(file) {
  const db = new Database(file);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE history (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO history VALUES (?, ?)').run('old-run', '{"中文":"原始结果","value":12.3}');
  return db;
}

test('first install creates the schema atomically', () => fixture(file => {
  expect(applyPreservingMigration(file, 'CREATE TABLE history (id TEXT PRIMARY KEY);').backupPath).toBeUndefined();
  const db = new Database(file); try { expect(db.prepare('SELECT * FROM history').all()).toEqual([]); } finally { db.close(); }
}));

test('SQLite table reconstruction preserves WAL history and creates a readable backup', () => fixture(file => {
  const prior = initialize(file);
  try {
    const result = applyPreservingMigration(file, `PRAGMA foreign_keys=OFF;
      CREATE TABLE new_history (id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      INSERT INTO new_history (id,value) SELECT id,value FROM history;
      DROP TABLE history; ALTER TABLE new_history RENAME TO history;
      PRAGMA foreign_keys=ON;`);
    expect(prior.prepare('SELECT * FROM history').get()).toMatchObject({ id: 'old-run', revision: 1 });
    const backup = new Database(result.backupPath, { readonly: true });
    try { expect(backup.prepare('SELECT value FROM history').get()).toEqual(prior.prepare('SELECT value FROM history').get()); } finally { backup.close(); }
  } finally { prior.close(); }
}));

test.each([
  ['table removal', 'DROP TABLE history;'],
  ['column removal', 'ALTER TABLE history DROP COLUMN value;'],
  ['row removal', 'DELETE FROM history;'],
  ['same-count data replacement', "UPDATE history SET value='replaced';"],
  ['partial DDL followed by failure', 'ALTER TABLE history ADD COLUMN extra TEXT; INSERT INTO missing VALUES (1);'],
])('refuses %s and rolls back every prior change', (_, sql) => fixture(file => {
  const prior = initialize(file);
  try {
    const before = prior.prepare('SELECT * FROM history').all();
    expect(() => applyPreservingMigration(file, sql)).toThrow();
    expect(prior.prepare('SELECT * FROM history').all()).toEqual(before);
    expect(prior.pragma('table_info(history)').map(column => column.name)).toEqual(['id', 'value']);
  } finally { prior.close(); }
}));

test('foreign-key violations are rejected before publishing a migrated database', () => fixture(file => {
  const prior = initialize(file);
  try {
    expect(() => applyPreservingMigration(file, "CREATE TABLE refs (id TEXT REFERENCES history(id)); INSERT INTO refs VALUES ('unknown');")).toThrow('integrity');
    expect(prior.prepare("SELECT name FROM sqlite_master WHERE name='refs'").get()).toBeUndefined();
  } finally { prior.close(); }
}));
