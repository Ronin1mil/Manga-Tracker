import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import { isFirefox, readInbox, readVisits } from '../src/main/chromeHistory';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sources-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const UNIX_TO_CHROME = 11644473600000000;

describe('inbox file', () => {
  const file = path.join(dir, 'manga-inbox.txt');
  const NOW = Date.parse('2026-11-14T20:00:00Z');

  it('reads links, titles and dates, and only whole lines', () => {
    fs.writeFileSync(file, [
      'https://example.com/manga/one/chapter-5',
      'https://example.com/manga/two/chapter-9\tTwo Chapter 9',
      '2026-11-10T12:00:00Z\thttps://example.com/manga/three/chapter-2\tThree Chapter 2',
      'not a link at all',
      'https://example.com/manga/four/chapter-1 | Four',
      'https://example.com/manga/half/chap',
    ].join('\r\n'));
    const r = readInbox(file, 0, NOW);
    expect(r.visits.map((v) => v.url)).toEqual([
      'https://example.com/manga/one/chapter-5',
      'https://example.com/manga/two/chapter-9',
      'https://example.com/manga/three/chapter-2',
      'https://example.com/manga/four/chapter-1',
    ]);
    expect(r.visits[1].title).toBe('Two Chapter 9');
    expect(r.visits[0].time).toBe(NOW * 1000 + UNIX_TO_CHROME);
    expect(r.visits[2].time).toBe(Date.parse('2026-11-10T12:00:00Z') * 1000 + UNIX_TO_CHROME);

    // Nothing new: nothing read again.
    expect(readInbox(file, r.offset, NOW).visits).toHaveLength(0);
    // The unfinished last line is picked up once it is complete.
    fs.appendFileSync(file, 'ter-3\n');
    const next = readInbox(file, r.offset, NOW);
    expect(next.visits.map((v) => v.url)).toEqual(['https://example.com/manga/half/chapter-3']);
  });

  it('starts over when the file was cleared, and copes with a missing file', () => {
    fs.writeFileSync(file, 'https://example.com/manga/new/chapter-1\n');
    expect(readInbox(file, 5000, NOW).visits).toHaveLength(1);
    expect(readInbox(path.join(dir, 'nope.txt'), 12, NOW)).toEqual({ visits: [], offset: 0 });
  });
});

describe('Firefox history', () => {
  it('reads visits from places.sqlite, even when the file is marked as WAL', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT)');
    db.run('CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER)');
    db.run("INSERT INTO moz_places VALUES (1, 'https://example.com/manga/one/chapter-5', 'One Chapter 5'), (2, 'https://other.test/page', 'Other')");
    const when = Date.parse('2026-11-01T10:00:00Z') * 1000;
    db.run('INSERT INTO moz_historyvisits VALUES (1, 1, ?), (2, 2, ?), (3, 1, ?)', [when, when, when + 1000]);
    const bytes = Buffer.from(db.export());
    db.close();
    bytes[18] = bytes[19] = 2; // what Firefox's own file looks like
    const file = path.join(dir, 'places.sqlite');
    fs.writeFileSync(file, bytes);

    expect(isFirefox(file)).toBe(true);
    const all = await readVisits(file, ['example.com'], 0);
    expect(all.map((v) => v.id)).toEqual([1, 3]);
    expect(all[0]).toMatchObject({ url: 'https://example.com/manga/one/chapter-5', title: 'One Chapter 5', time: when + UNIX_TO_CHROME });
    expect(await readVisits(file, ['example.com'], 1)).toHaveLength(1);
  });
});
