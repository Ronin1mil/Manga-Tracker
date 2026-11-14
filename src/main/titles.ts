/** Cleaning up the names aggregator sites give a series, and deciding whether a search hit is the same series. */

export const straighten = (s: string) => s.replace(/[‘’ʼ`´]/g, "'").replace(/[“”]/g, '"');

export const norm = (s: string) => straighten(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

const TAG = /\s*[([](?:manhwa|manga|manhua|webtoon|novel|web novel|light novel|official|remake|(?:19|20)\d\d)[)\]]\s*$/i;
const TAIL_WORD = /\s+(?:manhwa|manga|manhua|webtoon|novel|team\s+\p{L}+)$/iu;

function capitalise(s: string) {
  return s.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

/** "the-novel-s-extra-remake" -> "The Novel's Extra Remake". */
export function slugTitle(slug: string): string {
  const words = slug
    .replace(/^(?=[a-z]*\d)[a-z0-9]{2,6}-(?=.*[a-z]{3})/, '') // site id prefix such as "2vvd-"
    .replace(/-/g, ' ')
    // Apostrophes are lost in slugs: "novel s extra" -> "novel's extra", "i m really" -> "i'm really".
    .replace(/(\p{L}) s(?= |$)/gu, "$1's")
    .replace(/(^| )i m(?= )/g, "$1i'm")
    .replace(/(\p{L}n) t(?= |$)/gu, "$1't");
  return capitalise(words.trim());
}

/** Whether the site labelled this entry as a novel, so novel results are allowed. */
export function saysNovel(titleGuess: string, slug: string): boolean {
  return /\bnovel\b/i.test(titleGuess) && /(?:^|-)novel$/.test(slug);
}

/**
 * Names worth trying for one detected series, best first. The site's page title is often cut off,
 * decorated ("(Manhwa)", a year) or missing punctuation; the URL slug is complete but loses apostrophes.
 */
export function titleVariants(titleGuess: string, slug: string): string[] {
  const guess = straighten(titleGuess).replace(/\s+/g, ' ').trim();
  const fromSlug = slugTitle(slug);
  const out: string[] = [];
  const add = (t: string) => {
    const v = t.replace(/\s+/g, ' ').trim();
    if (v.length >= 2 && !out.some((o) => norm(o) === norm(v))) out.push(v);
  };
  const strip = (t: string) => {
    let v = t;
    for (let i = 0; i < 3; i++) v = v.replace(TAG, '').replace(TAIL_WORD, '');
    return v.replace(/\s+(?:19|20)\d\d$/, '');
  };

  const g = norm(guess);
  const s = norm(fromSlug);
  // A guess that is merely the start of the slug's name was cut off by the site.
  // (A slug that only adds digits, "versatile-mage01", is the same name with a site id glued on.)
  const cutOff = g.length >= 6 && s.length > g.length && s.startsWith(g) && !(/[a-z]\d+$/.test(slug) && /^\d+$/.test(s.slice(g.length)));
  // A guess with the same letters as the slug was built from the slug, so the repaired slug name is better.
  const repaired = g === s && fromSlug.includes("'") && !guess.includes("'");
  const primary = cutOff || repaired ? fromSlug : guess;
  add(strip(primary));
  // "Name (Other Name)" lists two names for the same series.
  const paren = /^(.{3,}?)\s*\((.{3,})\)\s*$/.exec(primary);
  if (paren) {
    add(strip(paren[1]));
    add(strip(paren[2]));
  }
  add(strip(fromSlug));
  add(strip(fromSlug).replace(/\s+\d{1,4}$/, '')); // trailing site id such as "_102"
  add(primary);
  if (!cutOff) add(guess);
  return out.slice(0, 5);
}

const STOP = new Set(['the', 'a', 'an']);
const tokens = (s: string) =>
  straighten(s).toLowerCase().normalize('NFKD').replace(/'/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w));

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1: how likely two names refer to the same series. 1 only for names identical after normalising. */
export function similarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  // Same words apart from "the"/"a": as good as identical.
  if (ta.length && ta.join(' ') === tb.join(' ')) return 0.98;
  const setB = new Set(tb);
  const shared = ta.filter((w) => setB.has(w));
  const dice = ta.length + tb.length ? (2 * shared.length) / (ta.length + tb.length) : 0;
  // A differing number means a sequel or another season, not the same series.
  const nums = (t: string[]) => t.filter((w) => /^\d+$/.test(w)).join(',');
  const numberClash = nums(ta) !== nums(tb);
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  const edit = 1 - editDistance(na, nb) / long.length;
  let score = Math.max(dice, edit);
  // One name is the cut-off start of the other.
  if (short.length >= 12 && long.startsWith(short) && short.length / long.length >= 0.6) score = Math.max(score, 0.92);
  if (numberClash) score = Math.min(score, 0.8);
  return Math.min(score, 0.97);
}

export interface Candidate {
  /** Main titles first, then synonyms / alternative titles. */
  names: (string | undefined)[];
  /** How many of `names` are main titles. */
  primary: number;
  totalChapters?: number;
  format?: string;
}

export const ACCEPT = 0.9;

/** A series with clearly fewer chapters than you've read is the wrong one (often a spin-off sharing the name). */
export function plausibleChapters(total: number | undefined, read: number): boolean {
  return !total || Math.floor(read) <= total + Math.max(5, total * 0.1);
}

/** Index and score of the candidate that is confidently the same series, if there is one. */
export function bestMatch(
  variants: string[],
  candidates: Candidate[],
  chapterRead = 0,
  wantNovel = false,
): { index: number; score: number; name: string } | undefined {
  const scored = candidates
    .map((c, index) => {
      if (!plausibleChapters(c.totalChapters, chapterRead)) return { index, score: 0, name: '' };
      if ((c.format === 'NOVEL') !== wantNovel) return { index, score: 0, name: '' };
      let score = 0;
      let matched = '';
      c.names.forEach((name, i) => {
        if (!name) return;
        for (const v of variants) {
          // An exact hit on a synonym ranks just under an exact hit on a main title.
          const sim = similarity(v, name) - (i >= c.primary ? 0.01 : 0);
          if (sim > score) {
            score = sim;
            matched = name;
          }
        }
      });
      return { index, score, name: matched };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const [best, second] = scored;
  if (!best || best.score < ACCEPT) return undefined;
  // Exact names win outright; a fuzzy match must be clearly ahead of the runner-up.
  if (best.score < 0.98 && second && best.score - second.score < 0.05) return undefined;
  return best;
}
