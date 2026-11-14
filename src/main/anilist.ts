import type { SeriesMeta, Status } from '../shared/types';

const ENDPOINT = 'https://graphql.anilist.co';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MEDIA = `
fragment M on Media {
  id title { romaji english native } synonyms description(asHtml: false)
  coverImage { extraLarge large } bannerImage chapters volumes status format
  startDate { year } genres siteUrl isAdult countryOfOrigin
  staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full } } } }
}`;

interface Media {
  id: number;
  title: { romaji?: string; english?: string; native?: string };
  synonyms?: string[];
  description?: string;
  coverImage?: { extraLarge?: string; large?: string };
  bannerImage?: string;
  chapters?: number;
  volumes?: number;
  status?: string;
  format?: string;
  countryOfOrigin?: string;
  startDate?: { year?: number };
  genres?: string[];
  siteUrl?: string;
  isAdult?: boolean;
  averageScore?: number;
  staff?: { edges: { role: string; node: { name: { full: string } } }[] };
}

export interface ListEntry {
  status: Status;
  progress: number;
  score: number;
  updatedAt: number;
  meta: SeriesMeta;
}

export type SearchHit = SeriesMeta & { synonyms: string[] };

let log: (line: string) => void = () => {};
export function setLogger(fn: (line: string) => void) {
  log = fn;
}

// AniList allows a fixed number of requests a minute. Requests go out one after another with no
// pause; only when the allowance is spent do they wait, for exactly as long as AniList asks.
let gate: Promise<unknown> = Promise.resolve();
let resumeAt = 0;

function gql<T>(query: string, variables: object, token?: string): Promise<T> {
  const run = gate.then(() => send<T>(query, variables, token));
  gate = run.catch(() => {});
  return run;
}

async function send<T>(query: string, variables: object, token?: string, attempt = 0): Promise<T> {
  if (resumeAt > Date.now()) await sleep(resumeAt - Date.now());
  const started = Date.now();
  const what = /^\s*(?:query|mutation)[^{]*\{\s*(?:\w+\s*:\s*)?(\w+)/.exec(query)?.[1] ?? 'request';
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  log(`anilist ${what}: HTTP ${res.status} in ${Date.now() - started} ms, rate limit ${res.headers.get('x-ratelimit-remaining') ?? '?'}/${res.headers.get('x-ratelimit-limit') ?? '?'} left`);
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('retry-after')) || 60;
    log(`anilist rate limited: waiting ${wait} s before retrying`);
    await sleep(wait * 1000);
    return send(query, variables, token, attempt + 1);
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    resumeAt = reset > Date.now() ? reset : Date.now() + 5000;
  }
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || json.errors?.length) {
    throw new Error(`AniList: ${json.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  }
  return json.data as T;
}

function clean(html?: string) {
  return html?.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

function isNsfw(m: { isAdult?: boolean; genres?: string[] }): boolean {
  return !!m.isAdult || (m.genres ?? []).includes('Hentai');
}

/** The adult flag for series saved before it was recorded. Ids AniList no longer has are left out. */
export async function adultFlags(ids: number[], token?: string): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql<{ Page: { media: { id: number; isAdult?: boolean; genres?: string[] }[] } }>(
      'query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: MANGA) { id isAdult genres } } }',
      { ids: ids.slice(i, i + 50) },
      token,
    );
    for (const m of d.Page.media) out.set(m.id, isNsfw(m));
  }
  return out;
}

/** Country of origin for series saved before it was recorded. */
export async function countries(ids: number[], token?: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql<{ Page: { media: { id: number; countryOfOrigin?: string }[] } }>(
      'query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: MANGA) { id countryOfOrigin } } }',
      { ids: ids.slice(i, i + 50) },
      token,
    );
    for (const m of d.Page.media) if (m.countryOfOrigin) out.set(m.id, m.countryOfOrigin);
  }
  return out;
}

function toMeta(m: Media): SearchHit {
  return {
    anilistId: m.id,
    anilistUrl: m.siteUrl,
    titles: { romaji: m.title.romaji ?? undefined, english: m.title.english ?? undefined, native: m.title.native ?? undefined },
    description: clean(m.description),
    authors: [...new Set((m.staff?.edges ?? []).filter((e) => /story|art/i.test(e.role)).map((e) => e.node.name.full))],
    genres: m.genres ?? [],
    format: m.format ?? undefined,
    country: m.countryOfOrigin ?? undefined,
    year: m.startDate?.year ?? undefined,
    totalChapters: m.chapters ?? undefined,
    totalVolumes: m.volumes ?? undefined,
    pubStatus: m.status ?? undefined,
    communityScore: m.averageScore ?? undefined,
    adult: isNsfw(m),
    coverUrl: m.coverImage?.extraLarge ?? m.coverImage?.large ?? undefined,
    bannerUrl: m.bannerImage ?? undefined,
    synonyms: m.synonyms ?? [],
    altTitles: m.synonyms?.length ? m.synonyms : undefined,
    source: 'anilist',
  };
}

export interface RecLink {
  from: number;
  rating: number;
  media: SearchHit;
}

const REC_FIELDS = 'id type title { romaji english native } description(asHtml: false) coverImage { extraLarge large } chapters status format startDate { year } genres siteUrl isAdult averageScore countryOfOrigin';

/** What the community recommends for each of these series. Several series per request; the batch shrinks if AniList says the query is too complex. */
export async function recommendationsFor(ids: number[], token?: string, onProgress?: (done: number) => void): Promise<RecLink[]> {
  const out: RecLink[] = [];
  let size = 10;
  for (let i = 0; i < ids.length; ) {
    const batch = ids.slice(i, i + size);
    const query = `query (${batch.map((_, n) => `$i${n}: Int`).join(', ')}) {
      ${batch.map((_, n) => `r${n}: Page(perPage: 1) { media(id: $i${n}, type: MANGA) { id recommendations(sort: RATING_DESC, perPage: 8) { nodes { rating mediaRecommendation { ${REC_FIELDS} } } } } }`).join('\n')}
    }`;
    let d: Record<string, { media: { id: number; recommendations: { nodes: { rating: number; mediaRecommendation: (Media & { type?: string }) | null }[] } }[] }>;
    try {
      d = await gql(query, Object.fromEntries(batch.map((id, n) => [`i${n}`, id])), token);
    } catch (err) {
      if (/complexity/i.test(String((err as Error).message)) && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        log(`anilist recommendations: query too complex, now asking ${size} series at a time`);
        continue;
      }
      throw err;
    }
    for (const page of Object.values(d)) {
      for (const m of page.media) {
        for (const n of m.recommendations.nodes) {
          const rec = n.mediaRecommendation;
          if (rec && rec.type === 'MANGA' && n.rating > 0) out.push({ from: m.id, rating: n.rating, media: toMeta(rec) });
        }
      }
    }
    i += batch.length;
    onProgress?.(Math.min(i, ids.length));
  }
  return out;
}

export async function viewer(token: string): Promise<{ id: number; name: string }> {
  const d = await gql<{ Viewer: { id: number; name: string } }>('query { Viewer { id name } }', {}, token);
  return d.Viewer;
}

export async function fetchList(token: string, userId: number): Promise<ListEntry[]> {
  const d = await gql<{
    MediaListCollection: { lists: { entries: { status: Status; progress: number; score: number; updatedAt: number; media: Media }[] }[] };
  }>(
    `query ($userId: Int) { MediaListCollection(userId: $userId, type: MANGA) { lists { entries {
       status progress score(format: POINT_10_DECIMAL) updatedAt media { ...M } } } } } ${MEDIA}`,
    { userId },
    token,
  );
  const seen = new Map<number, ListEntry>();
  for (const list of d.MediaListCollection.lists) {
    for (const e of list.entries) {
      const { synonyms: _s, ...meta } = toMeta(e.media);
      seen.set(e.media.id, { status: e.status, progress: e.progress, score: e.score, updatedAt: e.updatedAt, meta });
    }
  }
  return [...seen.values()];
}

export async function search(q: string, token?: string): Promise<SearchHit[]> {
  const d = await gql<{ Page: { media: Media[] } }>(
    `query ($q: String) { Page(perPage: 10) { media(search: $q, type: MANGA) { ...M } } } ${MEDIA}`,
    { q },
    token,
  );
  return d.Page.media.map(toMeta);
}

/** How many title searches fit in one request under AniList's query complexity cap of 500. */
export const SEARCH_BATCH = 15;

/** Several title searches in a single request, so a long list costs few rate-limited calls. */
export async function searchMany(titles: string[], token?: string): Promise<SearchHit[][]> {
  if (!titles.length) return [];
  const d = await gql<Record<string, { media: Media[] }>>(
    `query (${titles.map((_, i) => `$q${i}: String`).join(', ')}) {
       ${titles.map((_, i) => `s${i}: Page(perPage: 8) { media(search: $q${i}, type: MANGA) { ...M } }`).join('\n')}
     } ${MEDIA}`,
    Object.fromEntries(titles.map((t, i) => [`q${i}`, t])),
    token,
  );
  return titles.map((_, i) => (d[`s${i}`]?.media ?? []).map(toMeta));
}

export interface EntryChange {
  mediaId: number;
  progress: number;
  status: Status;
  score?: number;
}

/** How many list changes go in one request. */
const SAVE_BATCH = 10;

async function saveBatch(token: string, batch: EntryChange[]): Promise<void> {
  const decl: string[] = [];
  const body: string[] = [];
  const vars: Record<string, unknown> = {};
  batch.forEach((e, n) => {
    decl.push(`$m${n}: Int, $p${n}: Int, $s${n}: MediaListStatus`);
    vars[`m${n}`] = e.mediaId;
    vars[`p${n}`] = Math.floor(e.progress);
    vars[`s${n}`] = e.status;
    let score = '';
    if (e.score != null) {
      decl.push(`$r${n}: Int`);
      vars[`r${n}`] = Math.round(e.score * 10);
      score = `, scoreRaw: $r${n}`;
    }
    body.push(`e${n}: SaveMediaListEntry(mediaId: $m${n}, progress: $p${n}, status: $s${n}${score}) { id }`);
  });
  await gql(`mutation (${decl.join(', ')}) { ${body.join('\n')} }`, vars, token);
}

/**
 * Send list changes to AniList, ten per request. If a batch is refused, its entries are sent
 * one by one so a single bad entry can't hold the others back. Returns the media ids that failed.
 */
export async function saveEntries(token: string, entries: EntryChange[], onProgress?: (done: number) => void): Promise<Map<number, string>> {
  const failed = new Map<number, string>();
  for (let i = 0; i < entries.length; i += SAVE_BATCH) {
    const batch = entries.slice(i, i + SAVE_BATCH);
    try {
      await saveBatch(token, batch);
    } catch (err) {
      if (batch.length === 1) failed.set(batch[0].mediaId, String((err as Error).message));
      else {
        for (const e of batch) {
          try {
            await saveBatch(token, [e]);
          } catch (one) {
            failed.set(e.mediaId, String((one as Error).message));
          }
        }
      }
    }
    onProgress?.(Math.min(i + SAVE_BATCH, entries.length));
  }
  return failed;
}

/** Full entries for known AniList ids (used when another source points at an AniList id). */
export async function byIds(ids: number[], token?: string): Promise<Map<number, SearchHit>> {
  const out = new Map<number, SearchHit>();
  for (let i = 0; i < ids.length; i += 25) {
    const d = await gql<{ Page: { media: Media[] } }>(
      `query ($ids: [Int]) { Page(perPage: 25) { media(id_in: $ids, type: MANGA) { ...M } } } ${MEDIA}`,
      { ids: ids.slice(i, i + 25) },
      token,
    );
    for (const m of d.Page.media) out.set(m.id, toMeta(m));
  }
  return out;
}
