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
];

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
  return out;
}

/**
 * Read visits to the tracked domains from a copy of a Chromium History file.
 * The browser keeps the original locked, and only rows on tracked domains leave the query.
 */
export async function readVisits(historyPath: string, domains: string[], afterId: number): Promise<Visit[]> {
  if (!domains.length) return [];
  const tmp = path.join(os.tmpdir(), `manga-tracker-history-${process.pid}.sqlite`);
  fs.copyFileSync(historyPath, tmp);
  try {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(tmp));
    try {
      const like = domains.map(() => 'u.url LIKE ?').join(' OR ');
      const stmt = db.prepare(
        `SELECT v.id AS id, u.url AS url, u.title AS title, v.visit_time AS time
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

export function onTracked(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => domainMatches(host, d));
  } catch {
    return false;
  }
}
