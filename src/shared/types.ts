export type Status = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REPEATING';

export const STATUS_LABEL: Record<Status, string> = {
  CURRENT: 'Reading',
  PLANNING: 'Planning',
  COMPLETED: 'Completed',
  PAUSED: 'Paused',
  DROPPED: 'Dropped',
  REPEATING: 'Rereading',
};

export interface Titles {
  romaji?: string;
  english?: string;
  native?: string;
}

/** Metadata that comes from AniList (or is typed in for local-only series). */
export interface SeriesMeta {
  anilistId?: number;
  anilistUrl?: string;
  titles: Titles;
  description?: string;
  authors?: string[];
  genres?: string[];
  format?: string;
  year?: number;
  totalChapters?: number;
  totalVolumes?: number;
  pubStatus?: string;
  /** Country it was first published in: JP, KR, CN or TW. Tells manga, manhwa and manhua apart. */
  country?: string;
  /** AniList's average reader score, 0-100; only kept for recommendation candidates. */
  communityScore?: number;
  /** AniList marks the series as adult (18+), or it carries the Hentai genre. */
  adult?: boolean;
  /** Other names the series goes by (synonyms, other languages); used to recognise it under a site's name. */
  altTitles?: string[];
  /** Where the details came from. 'site' = no source knows it; only what the reading site showed. */
  source?: 'anilist' | 'mangadex' | 'mangaupdates' | 'site';
  mangadexId?: string;
  mangaupdatesId?: number;
  /** Chapters released so far (from MangaUpdates), for series that are still coming out. */
  latestChapter?: number;
  /** Remote image URLs; the files in covers/ are the durable copies. */
  coverUrl?: string;
  bannerUrl?: string;
}

export interface Series extends SeriesMeta {
  id: string;
  /** File names inside covers/, present once downloaded. */
  cover?: string;
  banner?: string;
  status: Status;
  progress: number;
  score?: number;
  notes?: string;
  /** Where you read it; local only, never sent to AniList. */
  readAt?: string;
  /** Last chapter page detected from browser history. */
  lastUrl?: string;
  addedAt: number;
  updatedAt: number;
  /** Known only from a bookmark, not from anything you were seen reading. Kept out of the reading tabs and off AniList. */
  origin?: 'bookmark';
  /** The (cleaned) name your reading site uses; shown when the source has no English title. */
  siteTitle?: string;
  /** Added without details because no source had it; retried on later match runs. */
  needsDetails?: boolean;
  /** When you last read it (Unix ms): the newest page visit seen in browser history, or a manual chapter change. */
  lastReadAt?: number;
  /** Your thumb: 1 = like, -1 = dislike. Steers recommendations. */
  liked?: 1 | -1;
  /** When the released-chapter count was last looked up (Unix ms), found or not. */
  latestCheckedAt?: number;
  /** Local change not yet pushed to AniList. */
  dirty?: boolean;
}

export interface PendingMatch {
  /** "<domain>/<slug>" */
  key: string;
  domain: string;
  slug: string;
  titleGuess: string;
  chapter: number;
  url: string;
  /** Newest visit seen for this series (Unix ms). */
  lastReadAt?: number;
  /** 'history' = a page you actually opened (history or an open tab); 'bookmark' = only bookmarked. */
  source?: 'history' | 'bookmark';
}

export interface LibrarySettings {
  /** null = not asked yet */
  downloadImages: boolean | null;
  syncEnabled: boolean;
  /** Look unmatched titles up on MangaDex when AniList has nothing. Off only when set to false. */
  useMangadex?: boolean;
  /** Look novels and released-chapter counts up on MangaUpdates. Off only when set to false. */
  useMangaUpdates?: boolean;
  /** Version of the built-in site list already merged into trackedSites. */
  sitesSeeded?: number;
  /** NSFW series are hidden everywhere unless this is on. */
  showNsfw?: boolean;
  trackedSites: string[];
  /** Optional per-site regex (run against the URL path) with named groups `slug` and `chapter`. */
  siteOverrides: Record<string, string>;
}

export interface Library {
  schemaVersion: 1;
  settings: LibrarySettings;
  /** "<domain>/<slug>" -> series id */
  siteMappings: Record<string, string>;
  ignored: string[];
  pending: PendingMatch[];
  series: Series[];
  /** AniList ids of recommendations you said you're not interested in. */
  recDismissed?: number[];
  /** Country of origin has been looked up for series saved before it was recorded. */
  countryChecked?: boolean;
}

export interface Recommendation {
  meta: SeriesMeta;
  score: number;
  /** Up to three series in your library that led to this one. */
  because: string[];
}

/** Chapters read over time, counted from the real dates of page visits. */
export interface ReadingStats {
  /** First day with anything logged (YYYY-MM-DD). */
  since?: string;
  today: number;
  last7: number;
  last30: number;
  total: number;
  activeDays30: number;
  seriesRead30: number;
  /** Days in a row with at least one chapter, up to today or yesterday. */
  streak: number;
  best?: { day: string; chapters: number };
  /** The last 30 days, oldest first. */
  days: { day: string; chapters: number }[];
  /** The last 12 weeks (Monday to Sunday), oldest first. */
  weeks: { start: string; chapters: number }[];
  months: { month: string; chapters: number }[];
  /** Most-read series of the last 30 days. */
  top: { id?: string; title: string; chapters: number }[];
  /** Chapters in the last 30 days from series that are hidden or not in the library. */
  unnamed30: number;
}

export interface HistoryEvent {
  t: string;
  seriesId: string;
  title: string;
  field: 'progress' | 'status' | 'added' | 'removed';
  from?: number | string;
  to?: number | string;
  source: 'manual' | 'detected' | 'anilist' | 'undo';
  url?: string;
}

export interface BrowserProfile {
  label: string;
  path: string;
}

/** Another device signed into the same browser account, as the browser on this PC last saw it. */
export interface SyncDevice {
  guid: string;
  name: string;
  model?: string;
  kind: 'phone' | 'tablet' | 'computer' | 'other';
  /** Unix ms when the device last checked in. */
  lastSeen?: number;
  /** Its open tabs that are on tracked sites. */
  tabs: { url: string; title: string; lastActive?: number }[];
}

export type ViewSeries = Series & { coverSrc?: string };

export interface AppState {
  libraryPath?: string;
  library?: Omit<Library, 'series'> & { series: ViewSeries[] };
  loggedIn: boolean;
  viewerName?: string;
  clientId?: string;
  historyPath?: string;
  /** How many series are being held back because NSFW is hidden. */
  hiddenNsfw: number;
  /** The tracker starts by itself, in the background, when you sign in to Windows. */
  /** Beta: other browser history files read as well. */
  extraSources?: string[];
  /** Reading sites that have closed or moved; links on them no longer work. */
  deadSites?: string[];
  /** Beta: text file other apps add page links to. */
  inboxPath?: string;
  autostart: boolean;
  /** Offered on first run, before a library folder has been chosen. */
  suggestedLibrary?: string;
  activity: HistoryEvent[];
  /** Best recommendations first; empty until they have been fetched once. */
  recommendations: Recommendation[];
  recFetchedAt?: number;
  devices: SyncDevice[];
  /** Set when reading detection is on but no phone is reporting in. */
  phoneIssue?: string;
  lastSync?: number;
  lastScan?: number;
  busy?: string;
  error?: string;
}

/** Somewhere else to read a series whose site has closed. */
export interface SiteOption {
  site: string;
  url: string;
  /** found = checked, the series is there; guess = the usual link for that site, not checked; search = a web search. */
  kind: 'found' | 'guess' | 'search';
  note: string;
}

/** Everything the tracker knows, in one file, for moving to another PC or undoing a mistake. */
export interface Backup {
  app: 'manga-tracker-backup';
  version: 1;
  savedAt: string;
  library: Library;
  readingLog?: unknown;
  /** history.jsonl as text. */
  history?: string;
  recommendations?: unknown;
}

export type PendingAction =
  | { type: 'existing'; seriesId: string }
  | { type: 'anilist'; media: SeriesMeta }
  | { type: 'local'; title?: string }
  | { type: 'ignore' };

export const isNovel = (s: { format?: string }) => s.format === 'NOVEL';

/** "Manhwa", "Manhua", "Manga", "Novel"…: what kind of series this is, from its format and country. */
export function kindLabel(s: { format?: string; country?: string }): string | undefined {
  if (s.format === 'NOVEL') return s.country === 'KR' ? 'Korean novel' : s.country === 'CN' || s.country === 'TW' ? 'Chinese novel' : 'Novel';
  if (s.format === 'MANHWA' || s.country === 'KR') return 'Manhwa';
  if (s.format === 'MANHUA' || s.country === 'CN' || s.country === 'TW') return 'Manhua';
  if (s.format === 'ONE_SHOT') return 'One-shot';
  if (s.format === 'MANGA' || s.country === 'JP') return 'Manga';
  return s.format;
}

/** Chapters that are out and not read yet; undefined when nobody knows how many are out. */
export function unreadChapters(s: { totalChapters?: number; latestChapter?: number; progress: number }): number | undefined {
  const known = s.totalChapters ?? s.latestChapter;
  return known ? Math.max(0, Math.floor(known) - Math.floor(s.progress)) : undefined;
}

/** The highest chapter there is to read: the final count, else what's released so far, never less than what you've read. */
export function maxChapters(s: { totalChapters?: number; latestChapter?: number; progress: number }): number | undefined {
  const known = s.totalChapters ?? s.latestChapter;
  return known ? Math.max(known, Math.floor(s.progress)) : undefined;
}

/** How far through the series you are, 0-100. */
export function percentRead(s: { totalChapters?: number; latestChapter?: number; progress: number }): number | undefined {
  const max = maxChapters(s);
  return max ? Math.min(100, Math.round((s.progress / max) * 100)) : undefined;
}

/** English name first; failing that, the name your reading site uses, before the romanised or native one. */
export function displayTitle(s: { titles: Titles; siteTitle?: string }): string {
  return s.titles.english || s.siteTitle || s.titles.romaji || s.titles.native || 'Untitled';
}
