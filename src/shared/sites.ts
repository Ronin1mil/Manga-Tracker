/** Reading sites the tracker knows about: what they host, and how their chapter links look when the generic parser can't tell. */

export interface KnownSite {
  domain: string;
  kind: 'manga' | 'novel';
  /** Regex on the URL path with named groups `slug` and `chapter`, for sites the generic parser misreads. */
  pattern?: string;
}

export const KNOWN_SITES: KnownSite[] = [
  // Comics (manga, manhwa, manhua)
  { domain: 'mangahub.io', kind: 'manga' },
  { domain: 'comix.to', kind: 'manga' },
  { domain: 'mangakakalot.gg', kind: 'manga' },
  { domain: 'natomanga.com', kind: 'manga' },
  { domain: 'manganato.gg', kind: 'manga' },
  { domain: 'nelomanga.net', kind: 'manga' },
  { domain: 'mangafire.to', kind: 'manga', pattern: '^/read/(?<slug>[^/.]+)[^/]*/[a-z-]+/chapter-(?<chapter>\\d+(?:\\.\\d+)?)' },
  { domain: 'mangapark.net', kind: 'manga' },
  { domain: 'asuracomic.net', kind: 'manga', pattern: '^/series/(?<slug>[^/]+?)(?:-[0-9a-f]{8})?/chapter/(?<chapter>\\d+(?:\\.\\d+)?)' },
  { domain: 'reaperscans.com', kind: 'manga' },
  { domain: 'mangabuddy.com', kind: 'manga' },
  { domain: 'mangaread.org', kind: 'manga' },
  { domain: 'manhuaplus.com', kind: 'manga' },
  { domain: 'manhuaus.com', kind: 'manga' },
  { domain: 'kunmanga.com', kind: 'manga' },
  { domain: 'manhwaclan.com', kind: 'manga' },
  { domain: 'mangapill.com', kind: 'manga' },
  { domain: 'fanfox.net', kind: 'manga' },
  { domain: 'mangahere.cc', kind: 'manga' },
  // Novels
  { domain: 'novelbin.com', kind: 'novel' },
  { domain: 'novelbin.me', kind: 'novel' },
  { domain: 'novelfull.com', kind: 'novel' },
  { domain: 'novelfull.net', kind: 'novel' },
  { domain: 'freewebnovel.com', kind: 'novel' },
  { domain: 'novelfire.net', kind: 'novel' },
  { domain: 'lightnovelworld.org', kind: 'novel' },
  { domain: 'wuxiaworld.com', kind: 'novel', pattern: '^/novel/(?<slug>[^/]+)/[^/]*chapter-(?<chapter>\\d+)' },
  { domain: 'royalroad.com', kind: 'novel' },
  { domain: 'scribblehub.com', kind: 'novel' },
];

/**
 * Sites that have closed or moved. Nothing new can be read there, so they are not tracked in
 * the history, but old bookmarks on them still say which chapter you were on.
 */
export const OLD_SITES = [
  'mangafarm.com', 'mangajar.pro', 'mangajar.com', 'asurascans.com', 'asuratoon.com', 'asuracomics.com', 'asuracomics.gg',
  'asura.gg', 'flamescans.org', 'flamecomics.com', 'zeroscans.com', 'luminousscans.com', 'luminousscans.gg', '1stkissmanga.io',
  '1stkissmanga.me', 'mangakakalot.com', 'manganato.com', 'manganelo.com', 'readmanganato.com', 'chapmanganato.com', 'aquamanga.com',
  'manhuaes.com', 'mangatoto.com', 'bato.to', 'mangatx.com', 'isekaiscan.com', 'manga-raw.club', 'mangaowl.net', 'mangasee123.com',
  'manga4life.com', 'leviatanscans.com', 'alpha-scans.org', 'toonily.com', 'webtoon.xyz',
];

export function knownSite(domain: string): KnownSite | undefined {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return KNOWN_SITES.find((s) => d === s.domain || d.endsWith('.' + s.domain));
}

/** Whether a site hosts novels rather than comics. */
export const isNovelSite = (domain: string) => knownSite(domain)?.kind === 'novel';
