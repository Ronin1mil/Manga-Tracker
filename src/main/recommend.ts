import { displayTitle, maxChapters, type Recommendation, type Series, type SeriesMeta } from '../shared/types';

/** What AniList's community recommends for the series in the library, as fetched; scoring happens locally. */
export interface RecCandidate {
  meta: SeriesMeta;
  /** Library series (by AniList id) that recommend this one, with the community's rating of the link. */
  links: { from: number; rating: number }[];
}

export interface RecFile {
  fetchedAt: number;
  /** AniList ids of the library series that were asked about. */
  sources: number[];
  candidates: RecCandidate[];
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * How much you seem to like a series, from -2 to +2, using everything known about it:
 * your thumb and score when you gave one, otherwise how much of it you read, whether you
 * are caught up, how recently you read it, and whether you quietly stopped.
 */
export function weight(s: Series, now = Date.now()): number {
  if (s.liked) return s.liked * 2; // an explicit thumb overrides every guess below
  if (s.status === 'DROPPED') return -1;

  // Only bookmarked or planned: you were interested enough to save it, nothing more.
  if (s.origin === 'bookmark' || s.status === 'PLANNING') return s.score ? (s.score - 5) / 2.5 : 0.25;

  const max = maxChapters(s);
  const share = max ? Math.min(1, s.progress / max) : undefined;
  const volume = Math.min(1, s.progress / 40); // 40+ chapters is a real commitment whatever the length
  let w = share === undefined ? volume : 0.5 * volume + 0.5 * share;

  const idle = s.lastReadAt ? (now - s.lastReadAt) / DAY : undefined;
  const unread = max ? max - s.progress : 0;
  if (s.status === 'COMPLETED' || (share !== undefined && share >= 0.9)) {
    w = Math.max(w, 1) * 1.2; // finished or caught up: the strongest signal short of a thumb
  } else if (idle !== undefined && idle > 180 && unread >= 20) {
    // Plenty left and untouched for half a year: you stopped. Early = it didn't land; late = it wore thin.
    w = share !== undefined && share < 0.25 && s.progress < 30 ? -0.5 : w * 0.4;
  } else if (s.progress < 5 && idle !== undefined && idle > 60) {
    w = -0.25; // sampled a few chapters and never came back
  }
  if (s.status === 'PAUSED') w *= 0.6;
  if (w > 0 && idle !== undefined && idle < 30) w *= 1.25; // what you're into right now counts more

  // A score you gave is a direct statement; let it lead, with behaviour as the tiebreak.
  if (s.score) w = 0.7 * ((s.score - 5) / 2.5) + 0.3 * w;
  return Math.max(-2, Math.min(2, w));
}

/** The features a series is compared on: genres, where it's from (manga/manhwa/manhua/novel), and its era. */
function features(m: SeriesMeta): string[] {
  const out = (m.genres ?? []).map((g) => `g:${g}`);
  if (m.format) out.push(`f:${m.format}`);
  if (m.year) out.push(`y:${m.year >= 2020 ? '2020s' : m.year >= 2010 ? '2010s' : 'older'}`);
  return out;
}

/** Score the fetched candidates against your taste. Pure: no network, so a thumb re-ranks instantly. */
export function rank(series: Series[], file: RecFile | undefined, dismissed: number[], showNsfw: boolean, now = Date.now()): Recommendation[] {
  if (!file) return [];
  const byId = new Map(series.filter((s) => s.anilistId).map((s) => [s.anilistId!, s]));
  const weights = new Map(series.map((s) => [s, weight(s, now)]));
  const gone = new Set(dismissed);
  // Taste profile over every series in the library, matched to AniList or not:
  // what the ones you like have in common, minus what the ones you dislike do.
  const profile = new Map<string, number>();
  for (const s of series) {
    const w = weights.get(s)!;
    for (const f of features(s)) profile.set(f, (profile.get(f) ?? 0) + w);
  }
  const profileLen = Math.sqrt([...profile.values()].reduce((a, v) => a + v * v, 0));

  const out: Recommendation[] = [];
  for (const c of file.candidates) {
    const id = c.meta.anilistId;
    if (!id || byId.has(id) || gone.has(id)) continue;
    if (c.meta.adult && !showNsfw) continue;
    let score = 0;
    const because: { title: string; part: number }[] = [];
    for (const l of c.links) {
      const src = byId.get(l.from);
      if (!src) continue;
      const part = weights.get(src)! * Math.log(1 + Math.max(0, l.rating));
      score += part;
      if (part > 0) because.push({ title: displayTitle(src), part });
    }
    if (score <= 0) continue; // reached only through series you dislike, or nothing you care about
    const feats = features(c.meta);
    const dot = feats.reduce((a, f) => a + (profile.get(f) ?? 0), 0);
    const cos = profileLen && feats.length ? dot / (profileLen * Math.sqrt(feats.length)) : 0;
    score *= 1 + 0.4 * Math.max(-1, Math.min(1, cos)); // 0.6x for the opposite of your taste, 1.4x for a bullseye
    // How well readers at large rate it: 0.85x at 55/100 and below, 1.15x at 85/100 and above.
    if (c.meta.communityScore) score *= 1 + 0.15 * Math.max(-1, Math.min(1, (c.meta.communityScore - 70) / 15));
    out.push({ meta: c.meta, score, because: because.sort((a, b) => b.part - a.part).slice(0, 3).map((b) => b.title) });
  }
  return out.sort((a, b) => b.score - a.score);
}
