export interface ParsedChapter {
  domain: string;
  slug: string;
  chapter: number;
  titleGuess: string;
}

const GENERIC = new Set([
  'manga', 'mangas', 'read', 'reader', 'comic', 'comics', 'series', 'title', 'titles',
  'chapter', 'chapters', 'manhwa', 'manhua', 'webtoon', 'webtoons', 'viewer', 'book',
  'books', 'en', 'all', 'g', 'm', 'c',
]);
const CHAPTER_WORDS = new Set(['chapter', 'chapters', 'chap', 'ch', 'episode', 'ep']);

// "...chapter-45", "ch_45.5", "chapter-45-5" (= 45.5), optionally followed by words like "-english".
const IN_SEGMENT =
  /(?:^|[-_ ])(?:chapter|chap|ch|episode|ep)[-_ ]?(\d+(?:\.\d+)?)(?:[-_](\d))?(?:[-_][a-z]+)*$/;
const BARE_C = /^c(\d+(?:\.\d+)?)$/;
const NUMERIC = /^\d+(?:\.\d+)?$/;
const ID_LIKE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{16,})$/;
const BOT_WALL = /attention required|just a moment|cloudflare|access denied|are you a robot|page not found|\b404\b/i;
const IN_TITLE = /\b(?:chapter|ch\.?|episode|ep\.?)\s*#?(\d+(?:\.\d+)?)/i;

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return d;
}

export function domainMatches(host: string, tracked: string): boolean {
  const h = normalizeDomain(host);
  return h === tracked || h.endsWith('.' + tracked);
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
    .replace(/(?:-n\d+)?-abs[0-9a-z]{3,6}$/, ''); // a site's own id tail, as in "mashle-abs3yLi" or "unordinary-n5-abs36IU"
}

function deslug(raw: string): string {
  // Drop site id decorations such as "2vvd-some-title" or "some-title_102".
  const slug = raw
    .replace(/^\d{6,}[-_]+/, '')
    .replace(/^(?=[a-z]*\d)[a-z0-9]{2,6}[-_](?=.*[a-z]{3})/, '')
    .replace(/[-_]\d+$/, '');
  return slug.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();
}

function guessTitle(pageTitle: string | undefined, slug: string): string {
  if (pageTitle && !BOT_WALL.test(pageTitle)) {
    let t = pageTitle.replace(/^read\s+/i, '');
    const cut = t.search(/\s*[-–|:,·]?\s*(?:chapter|ch\.?|episode|ep\.?)\s*#?\d/i);
    // A title with no chapter marker is usually a generic or truncated page name, so only
    // trust it when the marker is there (or when the URL gave us no slug to fall back on).
    if (cut > 0) t = t.slice(0, cut).split(/\s[-–|]\s/).pop()!;
    else if (slug) t = '';
    else t = t.split(/\s[-–|]\s/)[0];
    t = t.replace(/\s+(?:manga|manhwa|manhua|online|raw)$/i, '').replace(/\s*\((?:19|20)\d\d\)$/, '').trim();
    if (t.length >= 2) return t;
  }
  return deslug(slug);
}

const SERIES_ROOTS = new Set(['manga', 'title', 'series', 'comic', 'manhwa', 'manhua', 'webtoon']);

/**
 * A link to a series page with no chapter in it (e.g. /manga/<slug>), as found in a site's own
 * bookmark list. Reported as chapter 0: the series is known, how far you've read is not.
 */
export function parseSeriesUrl(rawUrl: string, linkText?: string): ParsedChapter | null {
  let url: URL;
  let segs: string[];
  try {
    url = new URL(rawUrl);
    segs = decodeURIComponent(url.pathname).toLowerCase().split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (segs.length !== 2 || !SERIES_ROOTS.has(segs[0]) || ID_LIKE.test(segs[1]) || segs[1].length < 2) return null;
  const text = linkText?.replace(/\s+/g, ' ').replace(/\s+read (?:manga|manhwa|manhua) online.*$/i, '').trim() ?? '';
  const usable = text.length >= 2 && text.length <= 120 && !/^(read|continue|chapter|ch\.|remove|delete|bookmark)/i.test(text) && !BOT_WALL.test(text);
  return {
    domain: normalizeDomain(url.hostname),
    slug: slugify(segs[1].replace(/^\d{6,}[-_]+/, '')),
    chapter: 0,
    titleGuess: usable ? text : deslug(segs[1]),
  };
}

function valid(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n < 10000;
}

/**
 * Turn a page URL (and optional page title) into a series slug and chapter number.
 * Returns null when no chapter number can be found.
 */
export function parseChapterUrl(
  rawUrl: string,
  pageTitle?: string,
  override?: string,
): ParsedChapter | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const domain = normalizeDomain(url.hostname);
  if (/\.(?:jpe?g|png|webp|gif|avif)$/i.test(url.pathname)) return null; // a page image, not a chapter page
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }

  if (override) {
    try {
      const m = new RegExp(override, 'i').exec(pathname);
      if (m?.groups?.slug && m.groups.chapter) {
        const chapter = parseFloat(m.groups.chapter.replace(/[-_]/, '.'));
        if (valid(chapter)) {
          const slug = slugify(m.groups.slug);
          return { domain, slug, chapter, titleGuess: guessTitle(pageTitle, slug) };
        }
      }
    } catch {
      /* bad override regex: fall through to generic parsing */
    }
  }

  const segs = pathname
    .toLowerCase()
    .split('/')
    .map((s) => s.replace(/\.(?:html?|php|aspx?)$/, ''))
    .filter(Boolean);

  let chapter: number | undefined;
  let idx = segs.length;
  let prefix = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const m = IN_SEGMENT.exec(seg);
    if (m) {
      chapter = parseFloat(m[2] && !m[1].includes('.') ? `${m[1]}.${m[2]}` : m[1]);
      idx = i;
      prefix = seg.slice(0, m.index).replace(/^[-_ ]+|[-_ ]+$/g, '');
      // "1672760368-some-title-chapter-5": the leading number is a page id that changes every chapter.
      prefix = prefix.replace(/^\d{6,}[-_]+/, '');
      if (ID_LIKE.test(prefix)) prefix = '';
      break;
    }
    const bare = BARE_C.exec(seg);
    if (bare && i > 0) {
      chapter = parseFloat(bare[1]);
      idx = i;
      break;
    }
    if (CHAPTER_WORDS.has(seg) && segs[i + 1] && NUMERIC.test(segs[i + 1])) {
      idx = i;
      // "/chapter/301778/..." is a page id, not a chapter number: leave the number to the page title.
      if (valid(parseFloat(segs[i + 1]))) chapter = parseFloat(segs[i + 1]);
      break;
    }
  }
  if (chapter === undefined && pageTitle && !BOT_WALL.test(pageTitle)) {
    const m = IN_TITLE.exec(pageTitle);
    if (m) chapter = parseFloat(m[1]);
  }
  if (chapter === undefined || !valid(chapter)) return null;

  let slug = prefix.length >= 2 ? prefix : '';
  for (let j = Math.min(idx, segs.length) - 1; !slug && j >= 0; j--) {
    const seg = segs[j];
    if (GENERIC.has(seg) || ID_LIKE.test(seg) || seg.length < 2) continue;
    slug = seg;
  }
  slug = slugify(slug);
  const titleGuess = guessTitle(pageTitle, slug);
  if (!slug) slug = slugify(titleGuess);
  if (!slug) return null;
  return { domain, slug: slugify(slug), chapter, titleGuess };
}
