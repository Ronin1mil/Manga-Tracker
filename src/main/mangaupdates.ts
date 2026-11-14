import type { SeriesMeta } from '../shared/types';

/**
 * MangaUpdates (Baka-Updates): lists novels as well as comics, and records the latest released
 * chapter of each series. Used as the fallback for novels and for "how many chapters are out".
 */

const API = 'https://api.mangaupdates.com/v1';

let log: (line: string) => void = () => {};
export function setLogger(fn: (line: string) => void) {
  log = fn;
}

export interface MuHit {
  id: number;
  /** Names with the "(Novel)" tag removed. */
  names: string[];
  novel: boolean;
  year?: number;
}

export interface MuDetail extends MuHit {
  /** Chapters released so far, as far as MangaUpdates knows. */
  latestChapter?: number;
  completed: boolean;
  meta: SeriesMeta;
}

interface MuRecord {
  series_id: number;
  title: string;
  url?: string;
  description?: string;
  image?: { url?: { original?: string } };
  type?: string;
  year?: string;
  genres?: { genre: string }[];
  associated?: { title: string }[];
  latest_chapter?: number;
  status?: string;
  completed?: boolean;
  authors?: { name: string }[];
}

const FORMAT: Record<string, string> = { Novel: 'NOVEL', Manhwa: 'MANHWA', Manhua: 'MANHUA', Manga: 'MANGA' };
const ADULT = new Set(['Adult', 'Hentai', 'Smut']);

const clean = (t: string) => t.replace(/\s*[（(]\s*(?:novel|小説|小说|소설|web novel|light novel|wn|ln)\s*[)）]\s*$/i, '').trim();
const isNovel = (type?: string) => /novel/i.test(type ?? '');

async function request(pathname: string, body?: unknown, attempt = 0): Promise<unknown> {
  const started = Date.now();
  const res = await fetch(API + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'manga-tracker' },
    body: body ? JSON.stringify(body) : undefined,
  });
  log(`mangaupdates ${body ? 'search' : 'series'}: HTTP ${res.status} in ${Date.now() - started} ms`);
  if (res.status === 429 && attempt < 2) {
    log('mangaupdates rate limited: waiting 15 s before retrying');
    await new Promise((r) => setTimeout(r, 15000));
    return request(pathname, body, attempt + 1);
  }
  if (res.status === 429) throw new Error('MangaUpdates: rate limited, try again in a minute');
  if (!res.ok) throw new Error(`MangaUpdates: HTTP ${res.status}`);
  return res.json();
}

export async function search(title: string): Promise<MuHit[]> {
  const json = (await request('/series/search', { search: title, perpage: 10 })) as { results?: { record: MuRecord; hit_title?: string }[] };
  return (json.results ?? []).map(({ record: r, hit_title }) => ({
    id: r.series_id,
    names: [...new Set([clean(r.title), hit_title ? clean(hit_title) : ''].filter(Boolean))],
    novel: isNovel(r.type),
    year: Number(r.year) || undefined,
  }));
}

/** "270 WN Chapters (243 + 27 SS; Complete)" -> 270. */
export function chaptersInStatus(status?: string): number | undefined {
  const m = /(\d{1,5})\s+(?:WN\s+|Web Novel\s+|Main\s+)?Chapters?\b/i.exec(status ?? '');
  return m ? Number(m[1]) : undefined;
}

export async function detail(id: number): Promise<MuDetail> {
  const r = (await request(`/series/${id}`)) as MuRecord;
  const novel = isNovel(r.type);
  const names = [...new Set([r.title, ...(r.associated ?? []).map((a) => a.title)].map(clean).filter(Boolean))];
  const stated = chaptersInStatus(r.status);
  const latest = Math.max(r.latest_chapter ?? 0, stated ?? 0) || undefined;
  const genres = (r.genres ?? []).map((g) => g.genre);
  return {
    id: r.series_id,
    names,
    novel,
    year: Number(r.year) || undefined,
    latestChapter: latest,
    completed: !!r.completed,
    meta: {
      mangaupdatesId: r.series_id,
      source: 'mangaupdates',
      titles: { english: names[0] },
      altTitles: names.slice(0, 30),
      description: r.description?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim() || undefined,
      authors: [...new Set((r.authors ?? []).map((a) => a.name))],
      genres,
      format: FORMAT[r.type ?? ''] ?? (novel ? 'NOVEL' : undefined),
      year: Number(r.year) || undefined,
      totalChapters: r.completed ? latest : undefined,
      latestChapter: latest,
      pubStatus: r.completed ? 'FINISHED' : 'RELEASING',
      adult: genres.some((g) => ADULT.has(g)),
      coverUrl: r.image?.url?.original || undefined,
    },
  };
}
