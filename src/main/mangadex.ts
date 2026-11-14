import type { SeriesMeta } from '../shared/types';

/** MangaDex: the backup source for series AniList doesn't list or lists under another name. */

const API = 'https://api.mangadex.org';

let log: (line: string) => void = () => {};
export function setLogger(fn: (line: string) => void) {
  log = fn;
}

export interface DexHit {
  /** Every name MangaDex knows the series by, main title first. */
  names: string[];
  /** The AniList id MangaDex links to, when it has one. */
  anilistId?: number;
  meta: SeriesMeta;
}

interface DexManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    description?: Record<string, string>;
    links?: Record<string, string> | null;
    originalLanguage?: string;
    lastChapter?: string | null;
    status?: string;
    year?: number | null;
    contentRating?: string;
    tags?: { attributes: { name: Record<string, string>; group: string } }[];
  };
  relationships: { type: string; attributes?: { fileName?: string; name?: string } }[];
}

const STATUS: Record<string, string> = { ongoing: 'RELEASING', completed: 'FINISHED', hiatus: 'HIATUS', cancelled: 'CANCELLED' };
const FORMAT: Record<string, string> = { ko: 'MANHWA', zh: 'MANHUA', 'zh-hk': 'MANHUA', ja: 'MANGA' };

function toHit(m: DexManga): DexHit {
  const a = m.attributes;
  const main = a.title.en ?? Object.values(a.title)[0];
  const alts = a.altTitles.flatMap((t) => Object.entries(t));
  const pick = (...langs: string[]) => alts.find(([lang]) => langs.includes(lang))?.[1];
  // Show the English name when there is one; keep the romanised and native names alongside.
  const english = a.title.en ?? pick('en');
  const romaji = a.title['ja-ro'] ?? a.title['ko-ro'] ?? a.title['zh-ro'] ?? pick('ja-ro', 'ko-ro', 'zh-ro');
  const native = pick(a.originalLanguage ?? '', 'ja', 'ko', 'zh', 'zh-hk');
  const names = [...new Set([main, english, romaji, ...alts.map(([, v]) => v)].filter((n): n is string => !!n))];
  const cover = m.relationships.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  const last = Number(a.lastChapter);
  const al = Number(a.links?.al);
  return {
    names,
    anilistId: Number.isInteger(al) && al > 0 ? al : undefined,
    meta: {
      mangadexId: m.id,
      source: 'mangadex',
      titles: { english: english ?? main, romaji: romaji !== (english ?? main) ? romaji : undefined, native },
      altTitles: names.slice(0, 30),
      description: a.description?.en?.replace(/\n{3,}/g, '\n\n').trim() || undefined,
      authors: [...new Set(m.relationships.filter((r) => r.type === 'author' || r.type === 'artist').map((r) => r.attributes?.name).filter((n): n is string => !!n))],
      genres: (a.tags ?? []).filter((t) => t.attributes.group === 'genre' || t.attributes.group === 'theme').map((t) => t.attributes.name.en).filter(Boolean),
      format: FORMAT[a.originalLanguage ?? ''],
      year: a.year ?? undefined,
      totalChapters: a.status === 'completed' && Number.isFinite(last) && last > 0 ? Math.floor(last) : undefined,
      pubStatus: STATUS[a.status ?? ''],
      adult: a.contentRating === 'erotica' || a.contentRating === 'pornographic',
      coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover}.512.jpg` : undefined,
    },
  };
}

export async function search(title: string, attempt = 0): Promise<DexHit[]> {
  const q = new URLSearchParams({ title, limit: '8' });
  for (const inc of ['cover_art', 'author', 'artist']) q.append('includes[]', inc);
  for (const r of ['safe', 'suggestive', 'erotica', 'pornographic']) q.append('contentRating[]', r);
  const started = Date.now();
  const res = await fetch(`${API}/manga?${q}`, { headers: { 'User-Agent': 'manga-tracker', Accept: 'application/json' } });
  log(`mangadex search: HTTP ${res.status} in ${Date.now() - started} ms`);
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000));
    return search(title, attempt + 1);
  }
  if (res.status === 429) throw new Error('MangaDex: rate limited, try again in a minute');
  if (!res.ok) throw new Error(`MangaDex: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: DexManga[] };
  return (json.data ?? []).map(toHit);
}
