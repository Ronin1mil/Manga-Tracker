/** Working with reading-site links: which site a link is on, the next chapter's link, and the same series on another site. */

export function hostOf(url?: string): string | undefined {
  try {
    return new URL(url ?? '').hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** The link is on a site that has closed or moved. */
export function onDeadSite(url: string | undefined, dead: string[] | undefined): boolean {
  const h = hostOf(url);
  return !!h && !!dead?.some((d) => h === d || h.endsWith('.' + d));
}

/** The link to open for a series: the last chapter page, unless its site is gone and the saved "Read at" link still works. */
export function bestLink(s: { lastUrl?: string; readAt?: string }, dead?: string[]): string | undefined {
  const ok = [s.lastUrl, s.readAt].find((u) => u && !onDeadSite(u, dead));
  return ok ?? s.lastUrl ?? s.readAt;
}

// "chapter-12", "chapter_12", "chapter/12", "ch-12", "episode-12", with an optional ".5" or "-5" part.
const CHAPTER = /(chapters?|chap|ch|episode|ep)([-_/])(\d+)(?:[.-]\d+)?(?=$|\/)/gi;

/**
 * Where the chapter number sits in a link, so another number can be put there.
 * Undefined for links that carry a page id next to the chapter ("/6045978-chapter-58"),
 * because the next chapter's id can't be guessed.
 */
function chapterSlot(pathname: string): { start: number; end: number } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of pathname.matchAll(CHAPTER)) last = m as RegExpExecArray;
  if (!last || last.index === undefined) return undefined;
  if (last.index > 0 && !/[-_/]/.test(pathname[last.index - 1])) return undefined; // part of a word, e.g. "watch-1"
  const segStart = pathname.lastIndexOf('/', last.index) + 1;
  if (/\d{5,}/.test(pathname.slice(segStart, last.index))) return undefined;
  const numStart = last.index + last[1].length + 1;
  return { start: numStart, end: last.index + last[0].length };
}

/** The link of another chapter of the same series on the same site, when the site's links allow it. */
export function chapterUrl(lastUrl: string | undefined, chapter: number): string | undefined {
  let u: URL;
  try {
    u = new URL(lastUrl ?? '');
  } catch {
    return undefined;
  }
  const slot = chapterSlot(u.pathname);
  if (!slot || !(chapter >= 0)) return undefined;
  return `${u.origin}${u.pathname.slice(0, slot.start)}${chapter}${u.pathname.slice(slot.end)}`;
}

/** How a site builds its links, learned from one chapter link you opened there. `{slug}` and `{ch}` are the blanks. */
export interface SiteTemplate {
  /** A chapter page; missing when the site's chapter links can't be guessed. */
  chapter?: string;
  /** The series' own page; missing when it can't be told from the chapter link. */
  series?: string;
}

export function siteTemplate(sampleUrl: string, slug: string): SiteTemplate | undefined {
  let u: URL;
  try {
    u = new URL(sampleUrl);
  } catch {
    return undefined;
  }
  const p = u.pathname;
  const at = p.toLowerCase().indexOf(`/${slug.toLowerCase()}/`);
  if (!slug || at < 0) return undefined;
  const head = `${u.origin}${p.slice(0, at)}/{slug}`;
  const tail = p.slice(at + slug.length + 1);
  const slot = chapterSlot(tail);
  const before = p.slice(0, at).split('/').pop() ?? '';
  return {
    chapter: slot ? `${head}${tail.slice(0, slot.start)}{ch}${tail.slice(slot.end)}` : undefined,
    // "/chapter/<slug>/…" style sites keep the series page somewhere else.
    series: /^(chapters?|read|reader)$/i.test(before) ? undefined : `${head}/`,
  };
}

export const fill = (template: string, slug: string, chapter?: number) =>
  template.replace('{slug}', slug).replace('{ch}', String(chapter ?? 1));

/** "Solo Leveling: Ragnarok" -> "solo-leveling-ragnarok", the way most sites name a series in their links. */
export function slugFor(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A Google search for the series and chapter, optionally limited to one site. */
export function searchUrl(title: string, chapter?: number, site?: string): string {
  const q = [`"${title}"`, chapter !== undefined ? `chapter ${chapter}` : '', site ? `site:${site}` : ''].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
