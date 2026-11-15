import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readVisits } from '../src/main/chromeHistory';

type Db = { exec(sql: string): void; close(): void };
const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => { DatabaseSync: new (file: string) => Db } | undefined }).getBuiltinModule?.('node:sqlite');

describe('reading history while the browser is saving', () => {
  it.skipIf(!sqlite)('reads the last complete state, not the half-written one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-busy-'));
    const file = path.join(dir, 'History');
    const db = new sqlite!.DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
               CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
               CREATE INDEX visits_url ON visits (url);`);
      db.exec('BEGIN');
      for (let i = 1; i <= 300; i++) {
        db.exec(`INSERT INTO urls VALUES (${i}, 'https://example.com/manga/some-title/chapter-${i}', 'Some Title ${i}');
                 INSERT INTO visits VALUES (${i}, ${i}, ${13300000000000000 + i});`);
      }
      db.exec('COMMIT');
      // A big change left unfinished, with a tiny cache so half of it is already in the file.
      db.exec('PRAGMA cache_size = 5; BEGIN');
      for (let i = 301; i <= 6000; i++) {
        db.exec(`INSERT INTO urls VALUES (${i}, 'https://example.com/manga/some-title/chapter-${i}', '${'x'.repeat(200)}');
                 INSERT INTO visits VALUES (${i}, ${i}, ${13300000000000000 + i});`);
      }
      db.exec('DELETE FROM visits WHERE id <= 150');
      expect(fs.statSync(file + '-journal').size).toBeGreaterThan(0);

      const visits = await readVisits(file, ['example.com'], 0);
      expect(visits.length).toBe(300);
      expect(visits[0].id).toBe(1);
    } finally {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
