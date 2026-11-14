import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { BrowserProfile } from '../shared/types';
import { domainMatches } from './chapterParser';

export interface Visit {
  url: string;
  title?: string;
  /** Chrome timestamp: microseconds since 1601-01-01. */
  time: number;
  /** Row id in the visits table; 0 for bookmarks and synced tabs. */
  id?: number;
  kind?: 'history' | 'tab' | 'bookmark';
}

const BROWSERS: [string, string][] = [
  ['Chrome', 'Google/Chrome/User Data'],
  ['Brave', 'BraveSoftware/Brave-Browser/User Data'],
  ['Edge', 'Microsoft/Edge/User Data'],
  ['Vivaldi', 'Vivaldi/User Data'],
  ['Arc', 'Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data'],
];

/** Firefox keeps history in places.sqlite, with times in microseconds since 1970. */
export const isFirefox = (historyPath: string) => /places\.sqlite$/i.test(historyPath);
const UNIX_TO_CHROME = 11644473600000000;

export function listProfiles(): BrowserProfile[] {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const out: BrowserProfile[] = [];
  for (const [name, rel] of BROWSERS) {
    const root = path.join(local, rel);
    if (!fs.existsSync(root)) continue;
    // The browser's own account names ("PS5", "Work"…) are friendlier than "Default" / "Profile 2".
    let names: Record<string, { name?: string }> = {};
    try {
      names = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile?.info_cache ?? {};
    } catch {
      /* no names available */
    }
    for (const dir of fs.readdirSync(root)) {
      if (dir !== 'Default' && !dir.startsWith('Profile ')) continue;
      const file = path.join(root, dir, 'History');
      const account = names[dir]?.name;
      if (fs.existsSync(file)) out.push({ label: account ? `${name} — ${account} (${dir})` : `${name} — ${dir}`, path: file });
    }
  }
  const roaming = process.env.APPDATA;
  if (roaming) {
    for (const [name, rel] of [['Opera', 'Opera Software/Opera Stable'], ['Opera GX', 'Opera Software/Opera GX Stable']]) {
      for (const sub of ['Default', '']) {
        const file = path.join(roaming, rel, sub, 'History');
        if (fs.existsSync(file)) {
          out.push({ label: `${name} (beta)`, path: file });
          break;
        }
      }
    }
    const fx = path.join(roaming, 'Mozilla/Firefox/Profiles');
    if (fs.existsSync(fx)) {
      for (const dir of fs.readdirSync(fx)) {
        const file = path.join(fx, dir, 'places.sqlite');
        if (fs.existsSync(file)) out.push({ label: `Firefox — ${dir.replace(/^[^.]+\./, '')} (beta)`, path: file });
      }
    }
  }
  return out;
}

/**
 * Read visits to the tracked domains from a copy of a Chromium History file.
 * The browser keeps the original locked, and only rows on tracked domains leave the query.
 */
export async function readVisits(historyPath: string, domains: string[], afterId: number): Promise<Visit[]> {
  if (!domains.length) return [];
  const tmp = path.join(os.tmpdir(), `manga-tracker-history-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  fs.copyFileSync(historyPath, tmp);
  try {
    const SQL = await initSqlJs();
    const bytes = fs.readFileSync(tmp);
    const firefox = isFirefox(historyPath);
    // Firefox writes in "WAL" mode, which this reader can't open. Marking the copy as a plain
    // database reads everything Firefox has already folded into the main file (it does so every few minutes).
    if (bytes[18] === 2 && bytes[19] === 2) bytes[18] = bytes[19] = 1;
    const db = new SQL.Database(bytes);
    try {
      const like = domains.map(() => 'u.url LIKE ?').join(' OR ');
      const stmt = db.prepare(firefox
        ? `SELECT v.id AS id, u.url AS url, u.title AS title, v.visit_date + ${UNIX_TO_CHROME} AS time
           FROM moz_historyvisits v JOIN moz_places u ON u.id = v.place_id
           WHERE v.id > ? AND (${like}) ORDER BY v.id`
        : `SELECT v.id AS id, u.url AS url, u.title AS title, v.visit_time AS time
         FROM visits v JOIN urls u ON u.id = v.url
         WHERE v.id > ? AND (${like}) ORDER BY v.id`,
      );
      stmt.bind([afterId, ...domains.map((d) => `%${d}/%`)]);
      const out: Visit[] = [];
      while (stmt.step()) {
        const r = stmt.getAsObject() as { id: number; url: string; title: string | null; time: number };
        if (onTracked(r.url, domains)) out.push({ kind: 'history', id: Number(r.id), url: r.url, title: r.title ?? undefined, time: Number(r.time) });
      }
      stmt.free();
      return out;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const bookmarksFile = (historyPath: string) => path.join(path.dirname(historyPath), 'Bookmarks');

const READING_FOLDER = /manga|manhwa|manhua|webtoon|comic|novel/i;

/**
 * Bookmarks from the Bookmarks file next to the History file: every one on the given domains,
 * plus every one filed in a folder named for reading ("bookmarks for manga", "Light novels"…)
 * whatever site it is on. Whether a bookmark is really a chapter is decided by the caller.
 */
export function readBookmarks(historyPath: string, domains: string[]): Visit[] {
  const file = bookmarksFile(historyPath);
  if (!fs.existsSync(file)) return [];
  const out: Visit[] = [];
  const walk = (n: { url?: string; name?: string; children?: unknown[] }, reading: boolean) => {
    if (n.url && /^https?:/i.test(n.url) && (reading || onTracked(n.url, domains))) out.push({ kind: 'bookmark', url: n.url, title: n.name, time: 0 });
    const inside = reading || (!!n.children && READING_FOLDER.test(n.name ?? ''));
    for (const c of n.children ?? []) walk(c as typeof n, inside);
  };
  const roots = JSON.parse(fs.readFileSync(file, 'utf8')).roots as Record<string, object>;
  for (const r of Object.values(roots)) if (r && typeof r === 'object') walk(r, false);
  return out;
}

/**
 * A text file other apps add page links to: the way in for browsers whose history can't be read
 * from this PC, such as Safari on an iPhone (a share-sheet Shortcut appends to it; see docs).
 * One page per line: the link, optionally followed by a tab and the page title, optionally
 * preceded by a date and a tab. Returns the pages after byte `offset` and the new offset.
 */
export function readInbox(file: string, offset: number, now = Date.now()): { visits: Visit[]; offset: number } {
  if (!fs.existsSync(file)) return { visits: [], offset: 0 };
  const buf = fs.readFileSync(file);
  if (buf.length < offset) offset = 0; // the file was cleared or replaced
  // Only whole lines: a line still being written is left for the next read.
  const end = buf.lastIndexOf(10) + 1;
  if (end <= offset) return { visits: [], offset };
  const visits: Visit[] = [];
  for (const line of buf.subarray(offset, end).toString('utf8').split(/\r?\n/)) {
    const parts = line.replace(/^\uFEFF/, '').split('\t').map((p) => p.trim()).filter(Boolean);
    const at = parts.findIndex((p) => /^https?:\/\//i.test(p));
    if (at < 0) continue;
    const when = at > 0 ? Date.parse(parts[0]) : NaN;
    const ms = Number.isFinite(when) && when <= now ? when : now;
    visits.push({ kind: 'history', url: parts[at].split(/\s/)[0], title: parts[at + 1]?.slice(0, 300), time: ms * 1000 + UNIX_TO_CHROME });
  }
  return { visits, offset: end };
}

export function onTracked(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => domainMatches(host, d));
  } catch {
    return false;
  }
}
