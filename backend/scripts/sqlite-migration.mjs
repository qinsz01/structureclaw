import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const quote = value => `"${value.replaceAll('"', '""')}"`;

/** Apply generated SQLite DDL atomically, checking every old column and row. */
export function applyPreservingMigration(databasePath, sql) {
  const statements = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|ATTACH|DETACH|VACUUM)\b/i.test(statements)) {
    throw new Error('Migration contains transaction control / 迁移包含独立事务控制');
  }
  const existed = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
  const db = new Database(databasePath, { timeout: 5000 });
  let backupPath;
  try {
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (existed) {
      const backupDir = `${databasePath}.backups`;
      fs.mkdirSync(backupDir, { recursive: true });
      backupPath = path.join(backupDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`);
      // serialize includes committed WAL pages while this transaction blocks writers.
      fs.writeFileSync(backupPath, db.serialize(), { flag: 'wx', mode: 0o600 });
      db.prepare('ATTACH DATABASE ? AS before_migration').run(backupPath);
    }
    db.exec(sql);
    for (const { name } of tables) {
      if (!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name)) {
        throw new Error(`Migration would remove table / 迁移会删除已有表: ${name}`);
      }
      const oldColumns = db.prepare(`PRAGMA before_migration.table_info(${quote(name)})`).all().map(row => row.name);
      const columns = new Set(db.prepare(`PRAGMA main.table_info(${quote(name)})`).all().map(row => row.name));
      if (oldColumns.some(column => !columns.has(column))) {
        throw new Error(`Migration would remove stored fields / 迁移会删除已有字段: ${name}`);
      }
      const projection = oldColumns.map(quote).join(', ');
      const oldCount = db.prepare(`SELECT COUNT(*) AS n FROM before_migration.${quote(name)}`).get().n;
      const newCount = db.prepare(`SELECT COUNT(*) AS n FROM main.${quote(name)}`).get().n;
      const changed = db.prepare(`SELECT ${projection} FROM before_migration.${quote(name)} EXCEPT SELECT ${projection} FROM main.${quote(name)} LIMIT 1`).get();
      if (oldCount !== newCount || changed) {
        throw new Error(`Migration would change stored data / 迁移会改变已有数据: ${name}`);
      }
    }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
      throw new Error('Migration integrity check failed / 迁移完整性检查失败');
    }
    db.exec('COMMIT');
    return { backupPath };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw new Error(`${error.message}${backupPath ? `; backup / 备份: ${backupPath}` : ''}`, { cause: error });
  } finally {
    db.close();
  }
}
