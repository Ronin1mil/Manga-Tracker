import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  displayTitle,
  isNovel,
  type AppState,
  type LibrarySettings,
  type PendingAction,
  type PendingMatch,
  type Series,
  type SyncDevice,
  type SeriesMeta,
  type Status,
} from '../shared/types';
import * as al from './anilist';
import { normalizeDomain, parseChapterUrl, parseSeriesUrl } from './chapterParser';
import * as dex from './mangadex';
import * as mu from './mangaupdates';
import { rank, weight, type RecFile } from './recommend';
import { KNOWN_SITES, OLD_SITES, isNovelSite, knownSite } from '../shared/sites';
import { bestMatch, norm, plausibleChapters, saysNovel, straighten, titleVariants } from './titles';
import { bookmarksFile, listProfiles, onTracked, readBookmarks, readVisits, type Visit } from './chromeHistory';
import { ReadingLog } from './readingLog';
import { protect, unprotect } from './secret';
import { Store } from './store';
import { readSyncData } from './syncData';

interface Config {
  libraryPath?: string;
  token?: string;
  clientId?: string;
  viewer?: { id: number; name: string };
  historyPath?: string;
  /** Highest history row already processed. Synced visits arrive late with old timestamps, so rows are tracked by id. */
  lastVisitId?: number;
  lastScan?: number;
  lastSync?: number;
  /** Size and change time of the History and Bookmarks files when they were last read. */
  historyStamp?: string;
  bookmarksStamp?: string;
}

const PORT = Number(process.env.MANGA_TRACKER_PORT) || 47800;
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
// App settings (not the library) live here; overridable for tests and portable setups.
const userData = process.env.MANGA_TRACKER_USERDATA || path.join(process.env.APPDATA || os.homedir(), 'manga-tracker');
const webRoot = path.join(__dirname, '..', 'dist');
const clients = new Set<http.ServerResponse>();
let token: string | undefined | null = null; // null = not decrypted yet

let store: Store | undefined;
let cfg: Config = {};
let busy: string | undefined;
let lastError: string | undefined;
let syncing = false;
let scanning = false;
let matching = false;
let cancelMatching = false;
let devices: SyncDevice[] = [];
let devicesRead = false;

// ---------- reading log (for the stats) ----------

let readLog: { dir: string; log: ReadingLog } | undefined;
function readingLog(): ReadingLog {
  const st = need();
  if (readLog?.dir !== st.dir) readLog = { dir: st.dir, log: new ReadingLog(path.join(st.dir, 'reading-log.json')) };
  return readLog.log;
}

// ---------- start with Windows ----------

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'MangaTracker';
let autostart: boolean | undefined;
function isAutostart(): boolean {
  if (autostart === undefined) {
    autostart = process.platform === 'win32' && spawnSync('reg', ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true }).status === 0;
  }
  return autostart;
}
/** A per-user entry: no administrator rights needed, and it only runs for this Windows account. */
function setAutostart(on: boolean) {
  if (process.platform !== 'win32') throw new Error('Starting with the computer is only set up for Windows.');
  // conhost --headless runs the server with no window; --background stops it opening a browser tab.
  const conhost = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');
  const cmd = `"${conhost}" --headless "${process.execPath}" "${__filename}" --background`;
  const r = on
    ? spawnSync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', cmd, '/f'], { windowsHide: true })
    : spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { windowsHide: true });
  if (r.status !== 0 && on) throw new Error(`Could not set it up: ${String(r.stderr).trim() || 'reg.exe failed'}`);
  autostart = on;
  log(`autostart: ${on ? 'on' : 'off'}`);
}

const cfgFile = () => path.join(userData, 'config.json');
const saveCfg = () => fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STALE_MS = 3 * 24 * 60 * 60 * 1000;
function phoneIssue(): string | undefined {
  if (!cfg.historyPath || !devicesRead) return undefined;
  const phones = devices.filter((d) => d.kind === 'phone' || d.kind === 'tablet');
  if (!phones.length) {
    return 'No phone is syncing with this browser profile. On your phone, sign into the same browser account and turn on sync for History and Open Tabs.';
  }
  const newest = phones[0];
  if (newest.lastSeen && Date.now() - newest.lastSeen > STALE_MS) {
    return `${newest.name} was last seen on ${new Date(newest.lastSeen).toLocaleDateString()}. The browser on this PC has to be running to receive your phone's reading — open it and leave it in the background.`;
  }
  return undefined;
}

function getToken(): string | undefined {
  if (token === null) {
    try {
      token = cfg.token ? unprotect(cfg.token) : undefined;
    } catch {
      token = undefined;
    }
  }
  return token;
}

function openLibrary(dir: string) {
  store = new Store(dir);
  cfg.libraryPath = dir;
  saveCfg();
}

function state(): AppState {
  // Hidden NSFW series never leave the server, so no screen can show them by accident.
  const hide = (s: Series) => !!s.adult && !store?.lib.settings.showNsfw;
  const hidden = new Set(store?.lib.series.filter(hide).map((s) => s.id));
  return {
    libraryPath: cfg.libraryPath,
    hiddenNsfw: hidden.size,
    library: store && {
      ...store.lib,
      series: store.lib.series.filter((s) => !hidden.has(s.id)).map((s) => ({
        ...s,
        coverSrc:
          s.cover && fs.existsSync(store!.coverPath(s.cover))
            ? `/covers/${encodeURIComponent(s.cover)}`
            : s.coverUrl,
      })),
    },
    loggedIn: !!getToken(),
    viewerName: cfg.viewer?.name,
    clientId: cfg.clientId,
    historyPath: cfg.historyPath,
    autostart: isAutostart(),
    suggestedLibrary: store ? undefined : path.join(fs.existsSync('D:\\') ? 'D:\\' : path.join(os.homedir(), 'Documents'), 'MangaLibrary'),
    recommendations: store ? rank(store.lib.series, loadRecs(), store.lib.recDismissed ?? [], !!store.lib.settings.showNsfw).slice(0, 60) : [],
    recFetchedAt: store ? loadRecs()?.fetchedAt : undefined,
    activity: store ? store.activity.filter((e) => !hidden.has(e.seriesId)).slice(-60).reverse() : [],
    devices,
    phoneIssue: phoneIssue(),
    lastSync: cfg.lastSync,
    lastScan: cfg.lastScan,
    busy,
    error: lastError,
  };
}

const logFile = () => path.join(userData, 'log.txt');
/** Timings and errors, one line each, so slow steps can be seen after the fact. */
function log(line: string) {
  try {
    const f = logFile();
    if (fs.existsSync(f) && fs.statSync(f).size > 1_000_000) fs.renameSync(f, f.replace(/\.txt$/, '.old.txt'));
    fs.appendFileSync(f, `${new Date().toISOString()}  ${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}
al.setLogger(log);
dex.setLogger(log);
mu.setLogger(log);

function push() {
  if (!clients.size) return;
  const data = `data: ${JSON.stringify(state())}\n\n`;
  for (const c of clients) c.write(data);
}
function setBusy(text?: string) {
  busy = text;
  push();
}
function need(): Store {
  if (!store) throw new Error('Choose a library folder first.');
  return store;
}

// ---------- images ----------

async function downloadTo(url: string, base: string): Promise<string | undefined> {
  const st = need();
  const ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return undefined;
  const file = base + ext;
  fs.writeFileSync(st.coverPath(file), Buffer.from(await res.arrayBuffer()));
  return file;
}

let imageRun: Promise<void> | undefined;

/** Download missing covers and banners, six at a time. Calls made while a run is active wait for one more pass. */
function fetchImages(): Promise<void> {
  const run = (imageRun ?? Promise.resolve()).then(fetchImagesOnce);
  const mine: Promise<void> = run.catch(() => {}).finally(() => {
    if (imageRun === mine) imageRun = undefined;
  });
  imageRun = mine;
  return mine;
}

async function fetchImagesOnce() {
  const st = need();
  const missing = (file?: string) => !(file && fs.existsSync(st.coverPath(file)));
  // A series no source knows may still have a cover on the reading site's image server.
  for (const s of st.lib.series) {
    const slug = !s.coverUrl && s.needsDetails ? /^https:\/\/mangahub\.io\/chapter\/([a-z0-9-]+)\//.exec(s.lastUrl ?? '')?.[1] : undefined;
    if (slug) s.coverUrl = `https://thumb.mghcdn.com/mn/${slug}.jpg`;
  }
  // AniList covers can be shown straight from AniList, so they wait for the setting.
  // Others (MangaDex, reading sites) refuse to show inside another site, so they are always kept locally.
  const all = st.lib.settings.downloadImages === true;
  const wanted = (url?: string) => !!url && (all || !/anilist\.co\//.test(url));
  const todo = st.lib.series.filter((s) => (wanted(s.coverUrl) && missing(s.cover)) || (wanted(s.bannerUrl) && missing(s.banner)));
  if (!todo.length) return;
  const started = Date.now();
  let files = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++];
      try {
        if (wanted(s.coverUrl) && missing(s.cover)) {
          s.cover = await downloadTo(s.coverUrl!, s.id);
          if (s.cover) files++;
          else if (s.needsDetails) s.coverUrl = undefined; // the reading site has no cover under that name
        }
        if (wanted(s.bannerUrl) && missing(s.banner)) { s.banner = await downloadTo(s.bannerUrl!, `${s.id}-banner`); if (s.banner) files++; }
      } catch {
        failed++; // offline or image gone: try again next time
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  st.save();
  push();
  log(`images: ${files} files for ${todo.length} series in ${Date.now() - started} ms${failed ? `, ${failed} series failed` : ''}`);
}

// ---------- AniList sync ----------

const PULL_EVERY_MS = 60 * 60 * 1000;
let syncAgain = false;

/**
 * Send local changes to AniList. The whole list is fetched back only when asked (`pull`) or
 * when the last fetch is over an hour old, so a +1 click costs one small request.
 */
async function sync(pull = false) {
  const st = need();
  const token = getToken();
  if (!token || !st.lib.settings.syncEnabled) return;
  if (syncing) {
    syncAgain = true; // changes made during a sync go out right after it
    return;
  }
  syncing = true;
  syncAgain = false;
  setBusy('Syncing with AniList…');
  try {
    if (!cfg.viewer) cfg.viewer = await al.viewer(token);
    const entries = pull || Date.now() - (cfg.lastSync ?? 0) > PULL_EVERY_MS ? await al.fetchList(token, cfg.viewer.id) : [];
    if (entries.length) cfg.lastSync = Date.now();
    for (const e of entries) {
      const remoteAt = e.updatedAt * 1000;
      let s = st.byAnilist(e.meta.anilistId!);
      if (!s) {
        s = st.add(e.meta, { status: e.status, progress: e.progress, score: e.score || undefined }, 'anilist');
        s.updatedAt = remoteAt || s.updatedAt;
        continue;
      }
      Object.assign(s, e.meta);
      if (!s.dirty || remoteAt > s.updatedAt) {
        // Keep a local half-chapter (45.5) that AniList can only store as 45.
        if (Math.floor(s.progress) !== e.progress) st.setProgress(s, e.progress, 'anilist');
        st.setStatus(s, e.status, 'anilist');
        s.score = e.score || s.score;
        s.dirty = false;
      }
    }
    const dirty = st.lib.series.filter((s) => s.dirty && s.anilistId && !s.origin);
    if (dirty.length) {
      const sent = dirty.map((s) => ({ s, progress: s.progress, status: s.status, score: s.score }));
      const failed = await al.saveEntries(
        token,
        sent.map((x) => ({ mediaId: x.s.anilistId!, progress: x.progress, status: x.status, score: x.score })),
        (done) => setBusy(`Sending changes to AniList (${done}/${dirty.length})…`),
      );
      for (const x of sent) {
        // Changed again while it was being sent: leave it marked for the next round.
        if (!failed.has(x.s.anilistId!) && x.s.progress === x.progress && x.s.status === x.status && x.s.score === x.score) x.s.dirty = false;
      }
      log(`sync: sent ${dirty.length - failed.size} changes to AniList${failed.size ? `, ${failed.size} refused` : ''}`);
      for (const [id, why] of failed) log(`sync: AniList refused the change to media ${id}: ${why}`);
      if (failed.size) lastError = `AniList refused ${failed.size} of ${dirty.length} changes; see the log in Settings.`;
    }
    saveCfg();
    st.save();
    void fetchImages();
  } finally {
    syncing = false;
    setBusy(undefined);
  }
  if (syncAgain) void sync().catch(report);
}

/** Run `fn` over the items, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ---------- detection from browser history / bookmarks ----------

/** Chrome stores visit times as microseconds since 1601. Returns Unix ms, or undefined for "no time". */
function chromeTimeToMs(t?: number): number | undefined {
  const ms = t ? Math.round(t / 1000 - 11644473600000) : 0;
  return ms > 1_000_000_000_000 && ms < Date.now() + 86_400_000 ? ms : undefined;
}

function applyDetected(s: Series, chapter: number, url: string, at?: number) {
  const st = need();
  // Re-reads and catching up count as reading too, so the date moves even when the chapter doesn't.
  if (at && at > (s.lastReadAt ?? 0)) s.lastReadAt = at;
  if (chapter > s.progress) {
    st.setProgress(s, chapter, 'detected', url);
    s.lastUrl = url;
    if (s.status === 'PLANNING' || s.status === 'PAUSED') st.setStatus(s, 'CURRENT', 'detected');
  } else if (!s.lastUrl && chapter === s.progress) {
    s.lastUrl = url;
  }
}

function ingest(visits: Visit[]) {
  const st = need();
  // Pages you opened (history, open tabs) are proof of reading; bookmarks are only a hint.
  const proven = new Map<string, PendingMatch>();
  const marks = new Map<string, PendingMatch>();
  const readAt = new Map<string, number>();
  for (const v of visits) {
    let host = '';
    try {
      host = normalizeDomain(new URL(v.url).hostname);
    } catch {
      continue;
    }
    const override = Object.entries(st.lib.settings.siteOverrides).find(([d]) => host === d || host.endsWith('.' + d))?.[1] ?? knownSite(host)?.pattern;
    const p = parseChapterUrl(v.url, v.title, override) ?? (v.kind === 'bookmark' ? parseSeriesUrl(v.url, v.title) : null);
    if (!p) continue;
    const key = `${p.domain}/${p.slug}`;
    const at = v.kind === 'bookmark' ? undefined : chromeTimeToMs(v.time);
    if (at && at > (readAt.get(key) ?? 0)) readAt.set(key, at);
    if (at && p.chapter > 0) readingLog().add(key, p.chapter, at);
    const into = v.kind === 'bookmark' ? marks : proven;
    const cur = into.get(key);
    if (!cur || p.chapter > cur.chapter) into.set(key, { key, ...p, url: v.url });
  }
  for (const key of new Set([...proven.keys(), ...marks.keys()])) {
    if (st.lib.ignored.includes(key)) continue;
    const read = proven.get(key);
    const m = read ?? marks.get(key)!;
    const source = read ? 'history' : 'bookmark';
    let s = st.lib.siteMappings[key] ? st.get(st.lib.siteMappings[key]) : undefined;
    if (!s) {
      s = st.lib.series.find((x) => {
        const r = x.readAt?.toLowerCase();
        return !!r && r.includes(m.domain) && new RegExp(`/${m.slug}(?:[/?#]|$)`).test(r);
      });
      if (s) st.lib.siteMappings[key] = s.id;
    }
    if (s) {
      if (read) {
        if (s.origin) {
          delete s.origin; // seen being read: it graduates out of Bookmarks
          s.dirty = true;
        }
        applyDetected(s, read.chapter, read.url, readAt.get(key));
      } else if (s.origin === 'bookmark') {
        applyDetected(s, m.chapter, m.url);
      }
      continue;
    }
    const pend = st.lib.pending.find((x) => x.key === key);
    const seen = readAt.get(key);
    if (pend && seen && seen > (pend.lastReadAt ?? 0)) pend.lastReadAt = seen;
    if (!pend) st.lib.pending.push({ ...m, source, lastReadAt: seen });
    else if (source === 'history' && pend.source === 'bookmark') Object.assign(pend, m, { source });
    else if ((pend.source ?? 'history') === source && m.chapter > pend.chapter) Object.assign(pend, m, { source });
  }
  return new Set([...proven.keys(), ...marks.keys()]).size;
}

const BOOKMARKS_VERSION = 2;
const stamp = (file: string) => {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return 'none';
  }
};
const FULL_CHECK_MS = 30 * 60 * 1000;

/**
 * Read new reading from the browser. `quiet` is the background check: it does nothing at all
 * unless the browser's history or bookmarks file has changed (or half an hour has passed, for
 * tabs open on other devices), so an idle PC costs two file-size lookups.
 */
async function scan(full = false, quiet = false) {
  const st = need();
  if (!cfg.historyPath) throw new Error('Pick a browser history source in Settings first.');
  const domains = st.lib.settings.trackedSites;
  if (!domains.length) throw new Error('Add at least one tracked site in Settings first.');
  if (scanning) return;
  const rlog = readingLog();
  const historyStamp = stamp(cfg.historyPath);
  const bookmarksStamp = `${BOOKMARKS_VERSION}:${stamp(bookmarksFile(cfg.historyPath))}`;
  const firstLog = !rlog.data.backfilled;
  if (quiet && !firstLog && historyStamp === cfg.historyStamp && bookmarksStamp === cfg.bookmarksStamp && Date.now() - (cfg.lastScan ?? 0) < FULL_CHECK_MS) return;
  scanning = true;
  if (!quiet) setBusy(full ? 'Importing history and bookmarks…' : 'Checking browser history…');
  const scanStart = Date.now();
  const waiting = new Set(st.lib.pending.map((p) => p.key));
  try {
    // The reading log wants every visit the browser still remembers, once.
    const afterId = full || firstLog ? 0 : cfg.lastVisitId ?? 0;
    const visits = await readVisits(cfg.historyPath, domains, afterId);
    cfg.lastVisitId = visits.reduce((m, v) => Math.max(m, v.id ?? 0), afterId);
    visits.sort((a, b) => a.time - b.time); // oldest first, so each chapter is logged on the day it was first read
    if (afterId === 0 || bookmarksStamp !== cfg.bookmarksStamp) {
      const marks = readBookmarks(cfg.historyPath, [...domains, ...OLD_SITES]);
      visits.push(...marks);
      log(`bookmarks: ${marks.length} read from the browser (tracked sites, closed sites, and reading folders)`);
    }
    cfg.historyStamp = historyStamp;
    cfg.bookmarksStamp = bookmarksStamp;
    // Tabs open on your other devices: the freshest signal, and the only one for sites
    // that change chapter without loading a new page.
    try {
      const snap = await readSyncData(cfg.historyPath, domains);
      devices = snap.devices;
      devicesRead = true;
      visits.push(...snap.visits);
    } catch (err) {
      report(`Could not read synced devices: ${(err as Error).message}`);
    }
    ingest(visits);
    rlog.markBackfilled();
    rlog.save();
    if (full || visits.length) log(`scan${full ? ' (full import)' : ''}: ${visits.length} tracked pages read in ${Date.now() - scanStart} ms, ${st.lib.pending.length} waiting for a match`);
    cfg.lastScan = Date.now();
    saveCfg();
    st.save();
  } finally {
    scanning = false;
    if (!quiet) setBusy(undefined);
    else push();
  }
  // Anything newly found gets its cover and details straight away.
  if (st.lib.pending.some((p) => !waiting.has(p.key))) void autoMatch().catch(report);
}

function resolvePending(key: string, action: PendingAction) {
  const st = need();
  const p = st.lib.pending.find((x) => x.key === key);
  if (!p) return;
  st.lib.pending = st.lib.pending.filter((x) => x.key !== key);
  if (action.type === 'ignore') {
    st.lib.ignored.push(key);
    return;
  }
  let s: Series | undefined;
  const isNew = action.type === 'local' || (action.type === 'anilist' && !st.byAnilist(action.media.anilistId ?? -1));
  if (action.type === 'existing') s = st.get(action.seriesId);
  else if (action.type === 'anilist') s = st.add(action.media, { progress: 0 }, 'detected');
  else s = st.add({ titles: { english: action.title?.trim() || p.titleGuess } }, { progress: 0 }, 'detected');
  if (!s) return;
  st.lib.siteMappings[key] = s.id;
  if (isNew && p.source === 'bookmark') s.origin = 'bookmark';
  else if (p.source !== 'bookmark' && s.origin) delete s.origin;
  applyDetected(s, p.chapter, p.url, p.lastReadAt);
  return s;
}

/** One thing to look up: a detected series waiting for a match, or a library entry still missing its details. */
interface Job {
  label: string;
  variants: string[];
  chapter: number;
  allowNovel: boolean;
  pending?: PendingMatch;
  series?: Series;
  done?: boolean;
}

const namesOf = (m: SeriesMeta & { siteTitle?: string }) => [m.siteTitle, m.titles.english, m.titles.romaji, m.titles.native, ...(m.altTitles ?? [])];

/**
 * Match everything waiting in Review, and retry library entries that have no details yet.
 * Sources in order: the library itself, AniList, MangaDex. What no source knows is kept as a
 * site-only entry so nothing stays stuck.
 */
async function autoMatch() {
  const st = need();
  if (matching) return;
  matching = true;
  cancelMatching = false;
  const token = getToken();
  try {
    const started = Date.now();
    const jobs: Job[] = [
      ...st.lib.pending.map((p) => ({
        label: p.titleGuess, variants: titleVariants(p.titleGuess, p.slug), chapter: p.chapter,
        allowNovel: saysNovel(p.titleGuess, p.slug) || isNovelSite(p.domain), pending: p,
      })),
      ...st.lib.series.filter((x) => x.needsDetails).map((x) => ({
        label: displayTitle(x), variants: [...new Set([displayTitle(x).replace(/\s+Novel$/i, ''), ...(x.altTitles ?? [])])].slice(0, 5), chapter: x.progress, allowNovel: isNovel(x), series: x,
      })),
    ];
    const open = () => jobs.filter((j) => !j.done);
    const tally = { library: 0, anilist: 0, mangadex: 0, mangaupdates: 0, site: 0 };
    let failed = false;
    log(`match: started, ${jobs.length} to look up`);

    const inLibrary = (j: Job) => {
      const wanted = new Set(j.variants.map(norm));
      return st.lib.series.find((x) => x !== j.series && !x.needsDetails && (x.format === 'NOVEL') === j.allowNovel && namesOf(x).some((t) => t && wanted.has(norm(t))));
    };
    const linkExisting = (j: Job, existing: Series, via: string) => {
      if (j.pending) resolvePending(j.pending.key, { type: 'existing', seriesId: existing.id });
      else if (j.series) {
        // The entry without details turns out to be one already in the library: fold it in.
        for (const [k, v] of Object.entries(st.lib.siteMappings)) if (v === j.series.id) st.lib.siteMappings[k] = existing.id;
        if (j.series.progress > existing.progress) st.setProgress(existing, j.series.progress, 'detected', j.series.lastUrl);
        if ((j.series.lastReadAt ?? 0) > (existing.lastReadAt ?? 0)) existing.lastReadAt = j.series.lastReadAt;
        st.remove(j.series.id);
      }
      j.done = true;
      log(`match: "${j.label}" -> "${displayTitle(existing)}" (${via})`);
    };
    const apply = (j: Job, meta: SeriesMeta, via: 'anilist' | 'mangadex' | 'mangaupdates', score: number, matchedName: string) => {
      const existing = st.lib.series.find((x) => x !== j.series &&
        ((meta.anilistId && x.anilistId === meta.anilistId) || (meta.mangadexId && x.mangadexId === meta.mangadexId) ||
          (meta.mangaupdatesId && x.mangaupdatesId === meta.mangaupdatesId && x.source === 'mangaupdates')));
      if (existing) return linkExisting(j, existing, `already in library, via ${via}`);
      const target = j.pending ? resolvePending(j.pending.key, { type: 'anilist', media: meta }) : j.series;
      if (target) target.siteTitle = j.variants[0];
      if (j.series) {
        Object.assign(j.series, meta);
        delete j.series.needsDetails;
        j.series.updatedAt = Date.now();
        j.series.dirty = true;
      }
      j.done = true;
      tally[via]++;
      log(`match: "${j.label}" -> "${displayTitle(meta)}" (${via}, ${score.toFixed(2)}, on the name "${matchedName}")`);
    };
    const progress = (what: string) => setBusy(`Matching — ${what} (${jobs.length - open().length}/${jobs.length} done)`);

    // 1. Already in the library under one of its names.
    for (const j of open()) {
      const existing = inLibrary(j);
      if (existing) {
        linkExisting(j, existing, 'already in library');
        tally.library++;
      }
    }

    // 2. AniList: first the best name for everyone, then the other names for whoever is left.
    const hitsFor = new Map<Job, al.SearchHit[]>();
    const askAniList = async (asks: { job: Job; title: string }[]) => {
      for (let i = 0; i < asks.length && !cancelMatching && !failed; i += al.SEARCH_BATCH) {
        const batch = asks.slice(i, i + al.SEARCH_BATCH).filter((a) => !a.job.done);
        if (!batch.length) continue;
        progress('AniList');
        try {
          const results = await al.searchMany(batch.map((a) => a.title), token);
          batch.forEach((a, n) => {
            const seen = hitsFor.get(a.job) ?? [];
            for (const h of results[n]) if (!seen.some((x) => x.anilistId === h.anilistId)) seen.push(h);
            hitsFor.set(a.job, seen);
          });
          for (const j of new Set(batch.map((a) => a.job))) {
            if (j.done) continue;
            const existing = inLibrary(j); // an earlier match in this run may have added it
            if (existing) {
              linkExisting(j, existing, 'already in library');
              tally.library++;
              continue;
            }
            const hits = hitsFor.get(j)!;
            const best = bestMatch(j.variants, hits.map((h) => ({ names: [h.titles.english, h.titles.romaji, h.titles.native, ...h.synonyms], primary: 3, totalChapters: h.totalChapters, format: h.format })), j.chapter, j.allowNovel);
            if (best) {
              const { synonyms: _s, ...media } = hits[best.index];
              apply(j, media, 'anilist', best.score, best.name);
            }
          }
        } catch (err) {
          failed = true;
          lastError = String((err as Error).message ?? err);
          log(`match: AniList stopped on error: ${lastError}`);
        }
        st.save();
        push();
        void fetchImages(); // covers download alongside, from a different server than the search
      }
    };
    await askAniList(open().map((job) => ({ job, title: job.variants[0] })));
    await askAniList(open().flatMap((job) => job.variants.slice(1).map((title) => ({ job, title }))));

    // 3. MangaDex: knows many series AniList doesn't, lists far more alternative names, and often
    //    points back at the AniList entry.
    if (st.lib.settings.useMangadex !== false && !failed) {
      const viaDex: { job: Job; hit: dex.DexHit; score: number; name: string }[] = [];
      // MangaDex lists comics only. Three lookups at a time stays inside its five-a-second allowance.
      await pool(open().filter((j) => !j.allowNovel), 3, async (j) => {
        if (cancelMatching || failed) return;
        progress('MangaDex');
        try {
          for (const title of j.variants.slice(0, 3)) {
            const hits = await dex.search(title);
            const best = bestMatch(j.variants, hits.map((h) => ({ names: h.names, primary: 1, totalChapters: h.meta.totalChapters, format: undefined })), j.chapter, false);
            if (best) {
              viaDex.push({ job: j, hit: hits[best.index], score: best.score, name: best.name });
              break;
            }
          }
        } catch (err) {
          failed = true;
          lastError = String((err as Error).message ?? err);
          log(`match: MangaDex stopped on error: ${lastError}`);
        }
      });
      // Prefer the AniList entry MangaDex points at; fall back to MangaDex's own details.
      let linked = new Map<number, al.SearchHit>();
      const ids = [...new Set(viaDex.map((v) => v.hit.anilistId).filter((id): id is number => !!id))];
      if (ids.length) {
        try {
          linked = await al.byIds(ids, token);
        } catch (err) {
          log(`match: could not load AniList entries linked from MangaDex: ${(err as Error).message}`);
        }
      }
      for (const v of viaDex) {
        const hit = v.hit.anilistId ? linked.get(v.hit.anilistId) : undefined;
        if (hit && plausibleChapters(hit.totalChapters, v.job.chapter) && hit.format !== 'NOVEL') {
          const { synonyms: _s, ...media } = hit;
          // Keep MangaDex's names too: they are what matched the site's name.
          media.altTitles = [...new Set([...(media.altTitles ?? []), ...v.hit.names])].slice(0, 40);
          apply(v.job, media, 'anilist', v.score, v.name);
        } else {
          // MangaDex often files the romanised name as the main title; show the name that matched yours.
          const meta = { ...v.hit.meta, titles: { ...v.hit.meta.titles } };
          if (v.score >= 0.98 && meta.titles.english && norm(meta.titles.english) !== norm(v.name)) {
            meta.titles.romaji ??= meta.titles.english;
            meta.titles.english = v.name;
          }
          apply(v.job, meta, 'mangadex', v.score, v.name);
        }
      }
      st.save();
      push();
    }

    // 3b. MangaUpdates: the one source here that lists novels, and a last chance for comics.
    if (st.lib.settings.useMangaUpdates !== false && !failed) {
      await pool(open(), 4, async (j) => {
        if (cancelMatching || failed) return;
        progress('MangaUpdates');
        try {
          for (const title of j.variants.slice(0, 2)) {
            const hits = (await mu.search(title)).filter((h) => h.novel === j.allowNovel);
            const best = bestMatch(j.variants, hits.map((h) => ({ names: h.names, primary: 1, format: h.novel ? 'NOVEL' : undefined })), 0, j.allowNovel);
            if (!best) continue;
            const d = await mu.detail(hits[best.index].id);
            if (j.done) return;
            apply(j, d.meta, 'mangaupdates', best.score, best.name);
            if (j.series) j.series.latestCheckedAt = Date.now();
            break;
          }
        } catch (err) {
          failed = true;
          lastError = String((err as Error).message ?? err);
          log(`match: MangaUpdates stopped on error: ${lastError}`);
        }
      });
      st.save();
      push();
    }

    // 4. No source knows it: keep it anyway with the site's own name, to be retried on later runs.
    if (!failed && !cancelMatching) {
      for (const j of open()) {
        if (!j.pending) continue; // a library entry that still has no details just stays as it is
        const existing = inLibrary(j);
        if (existing) {
          linkExisting(j, existing, 'already in library');
          tally.library++;
          continue;
        }
        // A novel keeps "Novel" in its name so it can't be mistaken for the comic of the same title.
        const name = j.allowNovel ? straighten(j.label) : j.variants[0];
        const created = resolvePending(j.pending.key, { type: 'local', title: name });
        if (created) {
          created.source = 'site';
          created.needsDetails = true;
          created.altTitles = j.variants.slice(1);
          created.siteTitle = name;
          if (j.allowNovel) created.format = 'NOVEL';
          if (!created.readAt) created.readAt = j.pending.url;
        }
        j.done = true;
        tally.site++;
        log(`match: "${j.label}" -> kept as "${name}" (site only, no source has it)`);
      }
    }
    st.save();
    log(`match: finished in ${((Date.now() - started) / 1000).toFixed(1)} s — ${tally.library} already in library, ${tally.anilist} AniList, ${tally.mangadex} MangaDex, ${tally.mangaupdates} MangaUpdates, ${tally.site} site only, ${open().length} left${cancelMatching ? " (stopped by you)" : ""}`);
    setBusy('Downloading covers…');
    await fetchImages();
  } finally {
    matching = false;
    setBusy(undefined);
  }
  void refreshChapters().catch(report);
  void sync().catch(report); // newly matched series and raised chapters go to AniList now, not at the next hourly check
}

// ---------- recommendations ----------

let recs: { dir: string; file?: RecFile } | undefined;
const recPath = (dir: string) => path.join(dir, 'recommendations.json');
/** The saved candidates (recommendations.json in the library folder), read once per library. */
function loadRecs(): RecFile | undefined {
  if (!store) return undefined;
  if (recs?.dir !== store.dir) {
    recs = { dir: store.dir };
    try {
      recs.file = JSON.parse(fs.readFileSync(recPath(store.dir), 'utf8')) as RecFile;
    } catch {
      /* not fetched yet */
    }
  }
  return recs.file;
}

let recommending = false;
/** Ask AniList what its community recommends for the series you like, and save the answers for offline scoring. */
async function fetchRecommendations() {
  const st = need();
  if (recommending) return;
  recommending = true;
  const started = Date.now();
  try {
    const ids = st.lib.series.filter((s) => s.anilistId && weight(s) !== 0).map((s) => s.anilistId!);
    if (!ids.length) throw new Error('Recommendations need at least one series matched to AniList that you have read.');
    setBusy(`Finding recommendations (0/${ids.length})`);
    const links = await al.recommendationsFor(ids, getToken(), (done) => setBusy(`Finding recommendations (${done}/${ids.length})`));
    const byId = new Map<number, RecFile['candidates'][number]>();
    for (const l of links) {
      const id = l.media.anilistId!;
      const { synonyms: _s, ...meta } = l.media;
      const c = byId.get(id) ?? { meta, links: [] };
      c.links.push({ from: l.from, rating: l.rating });
      byId.set(id, c);
    }
    const file: RecFile = { fetchedAt: Date.now(), sources: ids, candidates: [...byId.values()] };
    fs.writeFileSync(recPath(st.dir), JSON.stringify(file));
    recs = { dir: st.dir, file };
    log(`recommendations: ${file.candidates.length} candidates from ${ids.length} series in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  } finally {
    recommending = false;
    setBusy(undefined);
  }
}

// ---------- released-chapter counts ----------

let refreshing = false;
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * AniList only gives a chapter count once a series has ended. For the rest, look up how many
 * chapters are out on MangaUpdates, four series at a time, and look again a week later.
 */
async function refreshChapters(force = false) {
  const st = need();
  if (refreshing || st.lib.settings.useMangaUpdates === false) return;
  const due = st.lib.series.filter((s) => !s.totalChapters && (force || !s.latestCheckedAt || Date.now() - s.latestCheckedAt > RECHECK_MS));
  if (!due.length) return;
  refreshing = true;
  const started = Date.now();
  let found = 0;
  let done = 0;
  const note = () => {
    if (!busy || busy.startsWith('Checking chapter counts')) setBusy(`Checking chapter counts (${done}/${due.length})`);
  };
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (next < due.length && !stop) {
      const s = due[next++];
      if (!st.lib.series.includes(s)) continue;
      note();
      const novel = isNovel(s);
      const names = [...new Set(namesOf(s).filter((n): n is string => !!n))];
      let id = s.mangaupdatesId;
      for (const q of [...new Set([displayTitle(s), s.siteTitle, s.titles.romaji].filter((n): n is string => !!n))].slice(0, 2)) {
        if (id) break;
        const hits = (await mu.search(q.replace(/\s+Novel$/i, ''))).filter((h) => h.novel === novel);
        const best = bestMatch(names, hits.map((h) => ({ names: h.names, primary: 1, format: h.novel ? 'NOVEL' : undefined })), 0, novel);
        if (best) id = hits[best.index].id;
      }
      if (id) {
        const d = await mu.detail(id);
        s.mangaupdatesId = id;
        if (d.latestChapter) {
          s.latestChapter = d.latestChapter;
          found++;
        }
      } else {
        log(`chapters: "${displayTitle(s)}" not found on MangaUpdates`);
      }
      s.latestCheckedAt = Date.now();
      if (++done % 10 === 0) {
        st.save();
        push();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: 6 }, () => worker().catch((err) => {
      stop = true;
      log(`chapters: stopped on error: ${(err as Error).message}`);
    })));
  } finally {
    refreshing = false;
    st.save();
    if (busy?.startsWith('Checking chapter counts')) setBusy(undefined);
    else push();
    log(`chapters: looked up ${done} of ${due.length} series in ${((Date.now() - started) / 1000).toFixed(0)} s, ${found} have a released-chapter count`);
  }
}

/**
 * Earlier versions sometimes matched a comic to the AniList entry of the novel it's based on.
 * A series filed as a novel but read on a comics site (and not labelled a novel there) is
 * moved to the comic's entry.
 */
async function fixNovelMismatches() {
  const st = need();
  const wrong = st.lib.series.filter((s) => {
    if (!isNovel(s) || !s.anilistId) return false;
    const keys = Object.entries(st.lib.siteMappings).filter(([, id]) => id === s.id).map(([k]) => k);
    return keys.length > 0 && keys.every((k) => {
      const [domain, slug] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)];
      return !isNovelSite(domain) && !/(?:^|-)novel$/.test(slug);
    });
  });
  if (!wrong.length) return;
  for (let i = 0; i < wrong.length; i += al.SEARCH_BATCH) {
    const batch = wrong.slice(i, i + al.SEARCH_BATCH);
    const results = await al.searchMany(batch.map((s) => s.titles.romaji ?? displayTitle(s)), getToken());
    batch.forEach((s, n) => {
      const names = namesOf(s).filter((t): t is string => !!t);
      const hits = results[n];
      const best = bestMatch(names, hits.map((h) => ({ names: [h.titles.english, h.titles.romaji, h.titles.native, ...h.synonyms], primary: 3, totalChapters: h.totalChapters, format: h.format })), s.progress, false);
      if (!best) {
        log(`novels: "${displayTitle(s)}" is filed as a novel but read on a comics site; no comic entry found on AniList`);
        return;
      }
      const { synonyms: _s, ...media } = hits[best.index];
      if (st.byAnilist(media.anilistId ?? -1)) return;
      log(`novels: "${displayTitle(s)}" moved from the novel's entry to the comic's (${media.format ?? 'comic'})`);
      Object.assign(s, { totalChapters: undefined, totalVolumes: undefined, bannerUrl: undefined }, media);
      s.cover = undefined;
      s.banner = undefined;
      s.latestChapter = undefined;
      s.mangaupdatesId = undefined;
      s.latestCheckedAt = undefined;
      s.updatedAt = Date.now();
      s.dirty = true;
    });
  }
  st.save();
  push();
}

/** Add the built-in reading sites to the tracked list once, and re-read history so past reading on them is picked up. */
const SITES_VERSION = 1;
function seedSites() {
  const st = need();
  const set = st.lib.settings;
  if ((set.sitesSeeded ?? 0) >= SITES_VERSION) return;
  set.sitesSeeded = SITES_VERSION;
  if (set.trackedSites.length) {
    const before = set.trackedSites.length;
    set.trackedSites = [...new Set([...set.trackedSites, ...KNOWN_SITES.map((k) => k.domain)])];
    cfg.lastVisitId = undefined;
    saveCfg();
    log(`sites: added ${set.trackedSites.length - before} known reading sites to the tracked list`);
  }
  st.save();
}

// ---------- IPC ----------

type Patch = Partial<Pick<Series, 'progress' | 'status' | 'score' | 'notes' | 'readAt' | 'titles'>> & { promote?: boolean };

const handlers: Record<string, (...a: any[]) => unknown> = {
  getState: () => state(),
  profiles: () => listProfiles(),
  chooseLibrary(dir: string) {
    const p = String(dir ?? '').trim().replace(/^"|"$/g, '');
    if (!path.isAbsolute(p)) throw new Error('Enter the full path of a folder, for example D:\\MangaLibrary.');
    fs.mkdirSync(p, { recursive: true });
    openLibrary(p);
  },
  updateSeries(id: string, patch: Patch) {
    const st = need();
    const s = st.get(id);
    if (!s) return;
    if (patch.progress != null && Number.isFinite(patch.progress)) {
      if (patch.progress > s.progress) {
        s.lastReadAt = Date.now();
        // A few chapters forward is reading; a big jump is a correction and stays out of the stats.
        if (patch.progress - s.progress <= 20) {
          for (let c = Math.floor(s.progress) + 1; c <= patch.progress; c++) readingLog().add(`id:${s.id}`, c, Date.now());
          readingLog().save();
        }
      }
      st.setProgress(s, Math.max(0, patch.progress), 'manual');
    }
    if (patch.status) st.setStatus(s, patch.status as Status, 'manual');
    if ('score' in patch && patch.score !== s.score) {
      s.score = patch.score || undefined;
      s.dirty = true;
      s.updatedAt = Date.now();
    }
    if ('notes' in patch) s.notes = patch.notes || undefined;
    if ('readAt' in patch) s.readAt = patch.readAt?.trim() || undefined;
    if (patch.titles) s.titles = patch.titles;
    if (patch.promote && s.origin) {
      delete s.origin;
      s.dirty = true;
      s.updatedAt = Date.now();
    }
    st.save();
    void sync().catch(report);
  },
  stats() {
    const st = need();
    const showNsfw = !!st.lib.settings.showNsfw;
    return readingLog().stats((key) => {
      const s = st.get(key.startsWith('id:') ? key.slice(3) : st.lib.siteMappings[key] ?? '');
      return s && (showNsfw || !s.adult) ? { id: s.id, title: displayTitle(s) } : undefined;
    });
  },
  setAutostart: (on: boolean) => setAutostart(!!on),
  async addSeries(meta: SeriesMeta) {
    const st = need();
    st.add(meta, { status: 'CURRENT' }, 'manual');
    st.save();
    await fetchImages();
    void sync().catch(report);
  },
  /** Fill in a site-only entry from a source result the user picked by hand. */
  async setDetails(id: string, meta: SeriesMeta) {
    const st = need();
    const s = st.get(id);
    if (!s) return;
    const twin = st.lib.series.find((x) => x !== s && meta.anilistId && x.anilistId === meta.anilistId);
    if (twin) throw new Error(`"${displayTitle(twin)}" is already in your library. Remove this entry or link its site to that one in Review.`);
    const { synonyms: _s, ...clean } = meta as SeriesMeta & { synonyms?: string[] };
    Object.assign(s, clean);
    delete s.needsDetails;
    s.updatedAt = Date.now();
    s.dirty = true;
    log(`match: "${s.siteTitle ?? displayTitle(s)}" -> "${displayTitle(meta)}" (picked by hand)`);
    st.save();
    await fetchImages();
    void sync().catch(report);
  },
  addLocal(title: string) {
    const st = need();
    if (!title.trim()) return;
    st.add({ titles: { english: title.trim() } }, { status: 'CURRENT' }, 'manual');
    st.save();
  },
  removeSeries(id: string) {
    const st = need();
    st.remove(id);
    st.save();
  },
  refreshChapters: () => void refreshChapters(true).catch(report),
  recommend: () => void fetchRecommendations().catch(report),
  rateSeries(id: string, liked: 1 | -1 | null) {
    const st = need();
    const s = st.get(id);
    if (!s) return;
    s.liked = liked === 1 || liked === -1 ? liked : undefined;
    st.save();
  },
  dismissRec(anilistId: number) {
    const st = need();
    st.lib.recDismissed = [...new Set([...(st.lib.recDismissed ?? []), Number(anilistId)])];
    st.save();
  },
  async addPlanned(meta: SeriesMeta) {
    const st = need();
    st.add(meta, { status: 'PLANNING' }, 'manual');
    st.save();
    await fetchImages();
  },
  async search(q: string) {
    const hits = await al.search(q, getToken());
    return store?.lib.settings.showNsfw ? hits : hits.filter((h) => !h.adult);
  },
  async setSettings(patch: Partial<LibrarySettings>) {
    const st = need();
    if (patch.trackedSites) {
      patch.trackedSites = [...new Set(patch.trackedSites.map(normalizeDomain).filter(Boolean))];
      patch.sitesSeeded = SITES_VERSION; // the list is now the user's own choice
      if (patch.trackedSites.some((d) => !st.lib.settings.trackedSites.includes(d))) cfg.lastVisitId = undefined; // read a new site's past history too
    }
    Object.assign(st.lib.settings, patch);
    st.save();
    if (patch.downloadImages) {
      setBusy('Downloading covers…');
      await fetchImages().finally(() => setBusy(undefined));
    }
  },
  setConfig(patch: Pick<Config, 'clientId' | 'historyPath'>) {
    if ('historyPath' in patch && patch.historyPath !== cfg.historyPath) {
      cfg.lastVisitId = undefined;
      devices = [];
      devicesRead = false;
    }
    Object.assign(cfg, patch);
    saveCfg();
  },
  async login(raw: string) {
    const t = raw.trim();
    cfg.viewer = await al.viewer(t);
    cfg.token = protect(t);
    token = t;
    saveCfg();
    await sync(true);
  },
  logout() {
    cfg.token = undefined;
    token = undefined;
    cfg.viewer = undefined;
    saveCfg();
  },
  sync: () => sync(true),
  scan: (full?: boolean) => scan(!!full),
  /** The Refresh button: look for new reading and exchange changes with AniList, at the same time. */
  async refresh() {
    await Promise.all([
      cfg.historyPath && store?.lib.settings.trackedSites.length ? scan() : undefined,
      getToken() && store?.lib.settings.syncEnabled ? sync(true) : undefined,
    ]);
  },
  autoMatch: () => void autoMatch().catch(report),
  cancelAutoMatch: () => {
    cancelMatching = true;
  },
  async resolvePending(key: string, action: PendingAction) {
    const st = need();
    resolvePending(key, action);
    st.save();
    await fetchImages();
  },
  undo(t: string) {
    const st = need();
    const ev = st.activity.find((e) => e.t === t && e.field === 'progress');
    const s = ev && st.get(ev.seriesId);
    if (ev && s && typeof ev.from === 'number') {
      st.setProgress(s, ev.from, 'undo');
      st.save();
    }
  },
  /** Links copied from a page (e.g. a site's own bookmark list). Treated as bookmarks: a hint, not proof of reading. */
  importLinks(links: { url?: unknown; title?: unknown }[]) {
    const st = need();
    const domains = st.lib.settings.trackedSites;
    if (!domains.length) throw new Error('Add the site to Tracked sites first.');
    const before = new Set(st.lib.pending.map((p) => p.key));
    const visits: Visit[] = (Array.isArray(links) ? links : [])
      .slice(0, 20000)
      .filter((l): l is { url: string; title?: unknown } => typeof l?.url === 'string' && onTracked(l.url, domains))
      .map((l) => ({ kind: 'bookmark', url: l.url, title: typeof l.title === 'string' ? l.title.slice(0, 300) : undefined, time: 0 }));
    const series = ingest(visits);
    st.save();
    return { links: visits.length, series, added: st.lib.pending.filter((p) => !before.has(p.key)).length };
  },
  exportCsv: () => need().toCsv(),
  openFolder() {
    if (cfg.libraryPath) spawn('explorer.exe', [cfg.libraryPath], { detached: true, stdio: 'ignore' }).unref();
  },
  openLog() {
    log('log opened from Settings');
    spawn('notepad.exe', [logFile()], { detached: true, stdio: 'ignore' }).unref();
  },
  clearError() {
    lastError = undefined;
  },
};

function report(err: unknown) {
  lastError = String((err as Error)?.message ?? err);
  log(`error: ${lastError}`);
  push();
}

// ---------- server ----------

/** Series matched before the adult flag was recorded get it filled in once. */
async function backfillAdult() {
  const st = need();
  const todo = st.lib.series.filter((s) => s.anilistId && s.adult === undefined);
  if (!todo.length) return;
  const flags = await al.adultFlags(todo.map((s) => s.anilistId!), getToken());
  for (const s of todo) s.adult = flags.get(s.anilistId!) ?? false;
  log(`nsfw: checked ${todo.length} existing series, ${todo.filter((s) => s.adult).length} marked adult`);
  st.save();
  push();
}

const REC_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything that runs by itself. Each part is independent, so they all start at once. */
function background() {
  if (!store) return;
  seedSites();
  void backfillAdult().catch(report);
  void fetchImages().catch(report);
  void fixNovelMismatches().catch(report).then(() => refreshChapters()).catch(report);
  if (getToken() && store.lib.settings.syncEnabled) void sync(true).catch(report);
  if (cfg.historyPath && store.lib.settings.trackedSites.length) void scan(false, true).catch(report);
}

/**
 * The periodic checks, sized to cost next to nothing while nothing is happening:
 * - new reading: every 5 minutes, but only two file-size lookups unless the browser wrote something;
 * - AniList: local changes go out when they are made; the list is fetched back once an hour;
 * - chapter counts: each series once a week; recommendations: once a week.
 */
function schedule() {
  setInterval(() => {
    if (store && cfg.historyPath && store.lib.settings.trackedSites.length) void scan(false, true).catch(report);
  }, 5 * 60 * 1000);
  setInterval(() => {
    if (store && getToken() && store.lib.settings.syncEnabled) void sync(true).catch(report);
  }, PULL_EVERY_MS);
  setInterval(() => {
    if (!store) return;
    void refreshChapters().catch(report);
    const fetched = loadRecs()?.fetchedAt;
    if (fetched && Date.now() - fetched > REC_REFRESH_MS) void fetchRecommendations().catch(report);
  }, 6 * 60 * 60 * 1000);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendFile(res: http.ServerResponse, file: string) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  });
}

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Only this machine's own browser tab may talk to the app: refuse other hosts and other sites' pages.
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  if (!ORIGINS.includes('http://' + host) || (origin && !ORIGINS.includes(origin))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://' + host);

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/call') {
    if (req.method !== 'POST' || !/^application\/json/.test(req.headers['content-type'] ?? '')) {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let out: object;
    try {
      const { name, args } = JSON.parse(body) as { name: string; args?: unknown[] };
      const fn = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
      if (!fn) throw new Error(`Unknown call: ${name}`);
      out = { ok: true, result: (await fn(...(args ?? []))) ?? null };
    } catch (err) {
      out = { ok: false, error: String((err as Error)?.message ?? err) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    push();
    return;
  }

  if (url.pathname.startsWith('/covers/')) {
    if (!store) {
      res.writeHead(404).end();
      return;
    }
    sendFile(res, store.coverPath(path.basename(decodeURIComponent(url.pathname))));
    return;
  }

  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = path.join(webRoot, rel || 'index.html');
  sendFile(res, file.startsWith(webRoot) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(webRoot, 'index.html'));
}

/** Started by Windows at sign-in: run quietly, without opening a browser window. */
const BACKGROUND = process.argv.includes('--background');

function openBrowser(force = false) {
  if (process.env.MANGA_TRACKER_NO_OPEN || (BACKGROUND && !force)) return;
  // Prefer Chrome, in its own app window: Chrome has to be running on this PC anyway for the
  // phone's history and tabs to sync down. Set MANGA_TRACKER_BROWSER=default to use the default browser.
  const chrome = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter((d): d is string => !!d)
    .map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    .find((p) => fs.existsSync(p));
  if (chrome && process.env.MANGA_TRACKER_BROWSER !== 'default') {
    // Open Chrome itself first, on the profile whose history is being read, so that profile is
    // signed in and syncing; then open the tracker as its own window in the same profile.
    const src = cfg.historyPath?.replace(/\\/g, '/') ?? '';
    // Naming the profile also skips Chrome's "who's using Chrome?" picker. Before a history
    // source has been chosen, fall back to the profile Chrome used last.
    let profile = /\/Google\/Chrome\/User Data\//i.test(src) ? path.basename(path.dirname(cfg.historyPath!)) : undefined;
    if (!profile) {
      try {
        const state = path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data', 'Local State');
        profile = JSON.parse(fs.readFileSync(state, 'utf8')).profile?.last_used;
      } catch {
        /* fall through to Default */
      }
    }
    const args = [`--profile-directory=${profile || 'Default'}`];
    spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => {
      spawn(chrome, [...args, ORIGINS[0]], { detached: true, stdio: 'ignore' }).unref();
    }, 2500);
    return;
  }
  spawn('cmd', ['/c', 'start', '', ORIGINS[0]], { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  fs.mkdirSync(userData, { recursive: true });
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); // never compete with whatever else the PC is doing
  } catch {
    /* not allowed here: run at normal priority */
  }
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
  } catch {
    cfg = {};
  }
  if (process.env.MANGA_TRACKER_LIBRARY) cfg.libraryPath = process.env.MANGA_TRACKER_LIBRARY;
  if (cfg.libraryPath) {
    try {
      store = new Store(cfg.libraryPath);
    } catch (err) {
      lastError = `Could not open library at ${cfg.libraryPath}: ${(err as Error).message}`;
      cfg.libraryPath = undefined;
    }
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log('Manga Tracker is already running. Opening it in your browser.');
      openBrowser();
      setTimeout(() => process.exit(0), 500);
    } else throw err;
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Manga Tracker is running at ${ORIGINS[0]}`);
    console.log('Keep this window open while you use it. Close it to stop.');
    console.log(`Log file: ${logFile()}`);
    log(`started on port ${PORT}`);
    openBrowser();
    background();
    schedule();
  });
}

main();

export { displayTitle };
