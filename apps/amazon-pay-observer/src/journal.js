import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class ReceiptJournal {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS receipts (
        identity TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
        discovered_at TEXT NOT NULL, submitted_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, outcome TEXT
      )`);
    if (filename !== ':memory:') { try { fs.chmodSync(filename, 0o600); } catch {} }
  }
  knownUrls() { return new Set(this.db.prepare('SELECT url FROM receipts').all().map(r => r.url)); }
  add(identity, url, text) {
    const existing = this.db.prepare('SELECT text FROM receipts WHERE identity = ?').get(identity);
    if (existing && existing.text !== text) throw new Error('CONFLICTING_RECEIPT');
    this.db.prepare('INSERT OR IGNORE INTO receipts (identity, url, text, discovered_at) VALUES (?, ?, ?, ?)')
      .run(identity, url, text, new Date().toISOString());
  }
  pending() { return this.db.prepare('SELECT * FROM receipts WHERE submitted_at IS NULL AND next_attempt_at <= ? ORDER BY discovered_at LIMIT 100').all(Date.now()); }
  pendingCount() { return this.db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE submitted_at IS NULL').get().count; }
  delivered(identity, outcome) { this.db.prepare('UPDATE receipts SET submitted_at = ?, outcome = ? WHERE identity = ?').run(new Date().toISOString(), outcome, identity); }
  failed(identity, attempts) {
    this.db.prepare('UPDATE receipts SET attempts = attempts + 1, next_attempt_at = ? WHERE identity = ?')
      .run(Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts, 6)), identity);
  }
  close() { this.db.close(); }
}
