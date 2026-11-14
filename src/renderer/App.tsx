import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  displayTitle,
  isNovel,
  maxChapters,
  percentRead,
  STATUS_LABEL,
  type AppState,
  type BrowserProfile,
  type PendingMatch,
  type ReadingStats,
  type SeriesMeta,
  type Status,
  type ViewSeries,
  kindLabel, unreadChapters,
  type Backup,
  type SiteOption,
} from '../shared/types';
import { bestLink, chapterUrl, hostOf, onDeadSite } from '../shared/links';
import { KNOWN_SITES } from '../shared/sites';

declare global {
  interface Window {
    api: {
      call: (name: string, ...args: unknown[]) => Promise<any>;
      onState: (cb: (s: AppState) => void) => void;
      onLink: (cb: (up: boolean) => void) => void;
    };
  }
}

const TABS: Status[] = ['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED'];
type Modal = 'add' | 'pending' | 'activity' | 'settings' | 'devices' | 'stats' | null;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Status | 'ALL' | 'BOOKMARKS' | 'FORYOU'>('CURRENT');
  const [query, setQuery] = useState('');
  const [sort, setSortRaw] = useState<SortKey>(() => saved('sort', 'read') as SortKey);
  const [reversed, setReversedRaw] = useState(() => saved('reversed', '') === '1');
  const setSort = (v: SortKey) => { setSortRaw(v); setReversedRaw(false); remember('sort', v); remember('reversed', ''); };
  const setReversed = (v: boolean) => { setReversedRaw(v); remember('reversed', v ? '1' : ''); };
  const [kind, setKind] = useState<'all' | 'manga' | 'novel'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [localError, setLocalError] = useState<string>();
  const [warned, setWarned] = useState(false);
  // null until the first state arrives; then whether the first-run walkthrough is showing.
  const [setup, setSetup] = useState<boolean | null>(null);

  // Clicks that are still waiting for the tracker to answer; shown as "Working…" once one takes a moment.
  const [waiting, setWaiting] = useState(0);
  const [slow, setSlow] = useState(false);
  const [down, setDown] = useState(false);
  const call = async (name: string, ...args: unknown[]) => {
    setWaiting((n) => n + 1);
    try {
      return await window.api.call(name, ...args);
    } catch (e) {
      setLocalError(String((e as Error).message ?? e));
    } finally {
      setWaiting((n) => n - 1);
    }
  };
  useEffect(() => {
    if (!waiting) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(t);
  }, [waiting]);

  useEffect(() => {
    window.api.onLink((up) => setDown(!up));
    window.api.onState(setState);
    void window.api.call('getState').then(setState);
  }, []);

  // Pop the Devices window open once per run when the phone isn't reporting in.
  useEffect(() => {
    if (state?.phoneIssue && !warned && modal === null && setup === false) {
      setWarned(true);
      setModal('devices');
    }
  }, [state?.phoneIssue, warned, modal, setup]);

  useEffect(() => {
    if (!state || setup !== null) return;
    const lib = state.library;
    const fresh = !lib || (!state.historyPath && !lib.series.length && !lib.pending.length);
    setSetup(fresh && !(lib && setupSkipped()));
  }, [state, setup]);

  const everything = state?.library?.series ?? [];
  const novelCount = useMemo(() => everything.filter(isNovel).length, [everything]);
  // Novels and comics are kept apart: a series is a novel when its source says so (a novel site, or a "novel" entry).
  const series = useMemo(() => (kind === 'all' ? everything : everything.filter((s) => isNovel(s) === (kind === 'novel'))), [everything, kind]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: 0, BOOKMARKS: 0 };
    for (const s of series) {
      if (s.origin === 'bookmark') {
        c.BOOKMARKS++;
        continue;
      }
      c.ALL++;
      const k = s.status === 'REPEATING' ? 'CURRENT' : s.status;
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [series]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return series
      .filter((s) => (tab === 'BOOKMARKS') === (s.origin === 'bookmark'))
      .filter((s) => tab === 'ALL' || tab === 'BOOKMARKS' || s.status === tab || (tab === 'CURRENT' && s.status === 'REPEATING'))
      .filter((s) => !q || [s.titles.english, s.titles.romaji, s.titles.native, s.siteTitle, ...(s.altTitles ?? [])].some((t) => t?.toLowerCase().includes(q)))
      .sort((a, b) => {
        // Series the sort has no value for (never read, no chapter count) stay at the bottom either way.
        const va = SORTS[sort].value(a);
        const vb = SORTS[sort].value(b);
        if (va === undefined || vb === undefined) return va === vb ? b.updatedAt - a.updatedAt : va === undefined ? 1 : -1;
        const c = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
        return (SORTS[sort].descending !== reversed ? -c : c) || b.updatedAt - a.updatedAt;
      });
  }, [series, tab, query, sort, reversed]);

  if (!state) return null;
  const error = localError ?? state.error;
  const clearError = () => {
    setLocalError(undefined);
    void window.api.call('clearError');
  };

  if (setup === null) return null;
  if (setup || !state.library) {
    const finish = (review?: boolean) => {
      markSetupDone();
      setSetup(false);
      clearError();
      if (review) setModal('pending');
    };
    return <Setup state={state} call={call} error={error} clearError={clearError} finish={finish} />;
  }

  const lib = state.library;
  const open = everything.find((s) => s.id === openId);
  const askImages = lib.settings.downloadImages === null && everything.some((s) => s.coverUrl);

  return (
    <div className="app">
      <header>
        <nav>
          {(['ALL', ...TABS, 'BOOKMARKS'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'tab on' : 'tab'}
              title={t === 'BOOKMARKS' ? 'Series found only in bookmarks, not yet seen in your reading history' : undefined}
              onClick={() => setTab(t)}
            >
              {t === 'ALL' ? 'All' : t === 'BOOKMARKS' ? 'Bookmarks' : STATUS_LABEL[t]} <span>{counts[t] ?? 0}</span>
            </button>
          ))}
          <button className={tab === 'FORYOU' ? 'tab on' : 'tab'} title="Series recommended from what you read and like" onClick={() => setTab('FORYOU')}>
            For you <span>{state.recommendations.length}</span>
          </button>
        </nav>
        <div className="tools">
          <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={kind} title="Show comics, novels, or both" onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">Manga + novels</option>
            <option value="manga">Manga only ({everything.length - novelCount})</option>
            <option value="novel">Novels only ({novelCount})</option>
          </select>
          <select value={sort} title="Sort by" onChange={(e) => setSort(e.target.value as SortKey)}>
            {(Object.keys(SORTS) as SortKey[]).map((k) => <option key={k} value={k}>{SORTS[k].label}</option>)}
          </select>
          <button
            className="dir"
            aria-pressed={reversed}
            title={`Showing ${SORTS[sort].order[reversed ? 1 : 0]}. Click to reverse.`}
            onClick={() => setReversed(!reversed)}
          >
            {SORTS[sort].descending !== reversed ? '↓' : '↑'} {SORTS[sort].order[reversed ? 1 : 0]}
          </button>
          <button
            className={lib.settings.showNsfw ? 'nsfw on' : 'nsfw'}
            aria-pressed={!!lib.settings.showNsfw}
            title={lib.settings.showNsfw ? 'NSFW series are showing. Click to hide them.' : `NSFW series are hidden${state.hiddenNsfw ? ` (${state.hiddenNsfw})` : ''}. Click to show them.`}
            onClick={() => call('setSettings', { showNsfw: !lib.settings.showNsfw })}
          >
            {lib.settings.showNsfw ? 'Hide NSFW' : `Show NSFW${state.hiddenNsfw ? ` (${state.hiddenNsfw})` : ''}`}
          </button>
          <button onClick={() => setModal('add')}>Add</button>
          <button onClick={() => call('refresh')}>Refresh</button>
          <button title="How much you read per day, week and month" onClick={() => setModal('stats')}>Stats</button>
          <button onClick={() => setModal('devices')}>Devices{state.phoneIssue ? ' ⚠' : ''}</button>
          <button onClick={() => setModal('activity')}>Activity</button>
          <button onClick={() => setModal('settings')}>Settings</button>
        </div>
      </header>

      {down && (
        <div className="bar err">
          <span><i className="spin" /> The tracker has stopped answering. Trying to reconnect… If this stays, start it again from its shortcut.</span>
        </div>
      )}
      {state.busy && (
        <div className="bar">
          <span><i className="spin" /> {state.busy}</span>
          {state.busy.startsWith('Matching') && <button onClick={() => call('cancelAutoMatch')}>Stop</button>}
        </div>
      )}
      {error && <div className="bar err">{error}<button onClick={clearError}>Dismiss</button></div>}
      {askImages && (
        <div className="bar">
          Download cover images from AniList into your library folder so they're kept locally?
          <span>
            <button className="primary" onClick={() => call('setSettings', { downloadImages: true })}>Download</button>
            <button onClick={() => call('setSettings', { downloadImages: false })}>No</button>
          </span>
        </div>
      )}
      {lib.pending.length > 0 && (
        <div className="bar">
          {lib.pending.length} series found in your browser history or bookmarks need matching.
          <button className="primary" onClick={() => setModal('pending')}>Review</button>
        </div>
      )}

      <main>
        {tab === 'CURRENT' && !query.trim() && <ContinueRow series={series} dead={state.deadSites} call={call} open={setOpenId} />}
        {tab === 'FORYOU' ? (
          <ForYou state={state} call={call} />
        ) : shown.length === 0 ? (
          <p className="empty">
            {everything.length === 0
              ? 'Nothing here yet. Add a series, connect AniList, or set up tracked sites in Settings.'
              : 'No series match.'}
          </p>
        ) : (
          <div className="grid">
            {shown.map((s) => (
              <div key={s.id} className="card" onClick={() => setOpenId(s.id)}>
                <Cover s={s} />
                <div className="flag"><StoppedBadge s={s} /></div>
                <Thumbs s={s} call={call} className="thumbs" />
                <button
                  className="plus"
                  title="Read one more chapter"
                  onClick={(e) => { e.stopPropagation(); void call('updateSeries', s.id, { progress: Math.floor(s.progress) + 1 }); }}
                >
                  +1
                </button>
                <div className="title">{displayTitle(s)}</div>
                <div className="ch">
                  <Chapters s={s} />
                  {s.lastReadAt ? <span title={`Last read ${new Date(s.lastReadAt).toLocaleString()}`}> · {shortAgo(s.lastReadAt)}</span> : null}
                  <Unread s={s} />
                  {s.status !== 'COMPLETED' && s.status !== 'DROPPED' && nextLink(s, state.deadSites).gone && (
                    <span className="badge closed" title="The site this was read on has closed or moved. Open the series to find it somewhere else."> Site closed</span>
                  )}
                  {isNovel(s) && <span className="badge novel" title="This is a novel, not a comic">Novel</span>}
                  {s.needsDetails && <span className="badge" title="No source has details for this series yet"> No details</span>}
                </div>
                {percentRead(s) !== undefined ? (
                  <div className="prog" title={`${percentRead(s)}% read`}><div style={{ width: `${percentRead(s)}%` }} /></div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </main>

      {!down && !state.busy && (slow || !!state.background?.length) && (
        <div className="working" role="status">
          <i className="spin" /> {slow ? 'Working…' : `In the background: ${state.background!.join(', ')}`}
        </div>
      )}
      {open && <Detail key={open.id} s={open} all={everything} dead={state.deadSites} call={call} close={() => setOpenId(null)} open={setOpenId} />}
      {modal === 'add' && <Add call={call} close={() => setModal(null)} />}
      {modal === 'pending' && <Pending state={state} call={call} close={() => setModal(null)} />}
      {modal === 'stats' && <Stats call={call} close={() => setModal(null)} open={(id) => { setModal(null); setOpenId(id); }} />}
      {modal === 'activity' && <Activity state={state} call={call} close={() => setModal(null)} />}
      {modal === 'devices' && <Devices state={state} call={call} close={() => setModal(null)} openSettings={() => setModal('settings')} />}
      {modal === 'settings' && <Settings state={state} call={call} error={error} close={() => setModal(null)} runSetup={() => { setModal(null); setSetup(true); }} />}
    </div>
  );
}

type Call = (name: string, ...args: unknown[]) => Promise<any>;

const SITES_HINT = KNOWN_SITES.map((k) => k.domain).join('\n');

/** "today", "3d ago", "2w ago", "5mo ago", "2y ago". */
type SortKey = 'read' | 'updated' | 'added' | 'title' | 'percent' | 'unread' | 'progress' | 'score';

/** Every sort: what it compares, which way it runs first, and what each direction is called. */
const SORTS: Record<SortKey, { label: string; value: (s: ViewSeries) => number | string | undefined; descending: boolean; order: [string, string] }> = {
  read: { label: 'Last read', value: (s) => s.lastReadAt, descending: true, order: ['newest first', 'oldest first'] },
  updated: { label: 'Last updated', value: (s) => s.updatedAt, descending: true, order: ['newest first', 'oldest first'] },
  added: { label: 'Date added', value: (s) => s.addedAt, descending: true, order: ['newest first', 'oldest first'] },
  title: { label: 'Title', value: (s) => displayTitle(s).toLowerCase(), descending: false, order: ['A to Z', 'Z to A'] },
  percent: { label: 'Percent read', value: (s) => percentRead(s), descending: true, order: ['most first', 'least first'] },
  // Caught-up series (0 new) have nothing to read, so they count as "no value" and sink.
  unread: { label: 'New chapters to read', value: (s) => unreadChapters(s) || undefined, descending: false, order: ['fewest first', 'most first'] },
  progress: { label: 'Chapters read', value: (s) => s.progress, descending: true, order: ['most first', 'fewest first'] },
  score: { label: 'Your score', value: (s) => s.score || undefined, descending: true, order: ['highest first', 'lowest first'] },
};

function saved(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(`mt-${key}`);
    return key === 'sort' ? (v && v in SORTS ? v : fallback) : v ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(`mt-${key}`, value);
  } catch {
    /* private window: just not remembered */
  }
}

/** What "continue" should open: the next chapter when one is out and the site's links allow it, else the last page read. */
function nextLink(s: ViewSeries, dead?: string[]): { url?: string; chapter?: number; gone: boolean } {
  const link = bestLink(s, dead);
  const gone = onDeadSite(link, dead);
  const next = Math.floor(s.progress) + 1;
  const url = !gone && (unreadChapters(s) ?? 0) > 0 ? chapterUrl(link, next) : undefined;
  return url ? { url, chapter: next, gone } : { url: link, gone };
}

/** The few series you read most recently that have chapters waiting, one click from the next chapter. */
function ContinueRow({ series, dead, call, open }: { series: ViewSeries[]; dead?: string[]; call: Call; open: (id: string) => void }) {
  const [hidden, setHidden] = useState(() => saved('continue', '') === 'off');
  const items = useMemo(
    () => series
      .filter((s) => !s.origin && (s.status === 'CURRENT' || s.status === 'REPEATING') && s.lastReadAt && (unreadChapters(s) ?? 0) > 0)
      .sort((a, b) => b.lastReadAt! - a.lastReadAt!)
      .slice(0, 8),
    [series],
  );
  if (!items.length) return null;
  return (
    <section className="continue">
      <div className="continueHead">
        <h3>Continue reading</h3>
        <button className="linkish" onClick={() => { setHidden(!hidden); remember('continue', hidden ? '' : 'off'); }}>{hidden ? 'Show' : 'Hide'}</button>
      </div>
      {!hidden && (
        <div className="continueRow">
          {items.map((s) => {
            const n = nextLink(s, dead);
            const unread = unreadChapters(s)!;
            const direct = !n.gone && !!n.url;
            return (
              <button
                key={s.id}
                className="cont"
                title={n.gone ? 'The site this was read on has closed. Click to find it somewhere else.' : n.chapter ? `Open chapter ${n.chapter} on ${hostOf(n.url)}` : `Open the last chapter you read on ${hostOf(n.url) ?? 'the site'}`}
                onClick={() => (direct ? void call('openExternal', n.url) : open(s.id))}
              >
                <Cover s={s} />
                <span className="title">{displayTitle(s)}</span>
                <span className="ch">{n.gone ? 'Site closed' : `Ch. ${Math.floor(s.progress) + 1} · ${unread > 999 ? '999+' : unread} new`}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** "3 new": chapters that are out and not read yet, for series you are following. */
function Unread({ s }: { s: ViewSeries }) {
  const n = unreadChapters(s);
  if (!n || s.status === 'COMPLETED' || s.status === 'DROPPED') return null;
  return <span className="badge new" title={`${n} chapter${n === 1 ? '' : 's'} out that you haven't read`}>{n > 999 ? '999+' : n} new</span>;
}

function shortAgo(ms: number) {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d < 1) return 'today';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/** Thumb up / down; clicking the lit one clears it. Steers the For you tab. */
function Thumbs({ s, call, className }: { s: ViewSeries; call: Call; className?: string }) {
  const set = (v: 1 | -1) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    void call('rateSeries', s.id, s.liked === v ? null : v);
  };
  return (
    <span className={`${className ?? ''} ${s.liked ? 'set' : ''}`}>
      <button className={s.liked === 1 ? 'thumb on up' : 'thumb'} aria-pressed={s.liked === 1} title="I like this: recommend more like it" onClick={set(1)}>👍</button>
      <button className={s.liked === -1 ? 'thumb on down' : 'thumb'} aria-pressed={s.liked === -1} title="Not for me: recommend less like it" onClick={set(-1)}>👎</button>
    </span>
  );
}

function ForYou({ state, call }: { state: AppState; call: Call }) {
  const recs = state.recommendations;
  return (
    <>
      <div className="row">
        <button className={recs.length ? '' : 'primary'} disabled={!!state.busy} onClick={() => call('recommend')}>
          {state.recFetchedAt ? 'Refresh recommendations' : 'Find recommendations'}
        </button>
        <span className="muted">
          {state.recFetchedAt
            ? `From AniList's community links, weighted by everything you've read: how far you got, how recently, what you stopped, your thumbs. Last fetched ${new Date(state.recFetchedAt).toLocaleDateString()}.`
            : 'Uses AniList\'s community recommendations for the series you read, weighted by your thumbs. Takes about a minute.'}
        </span>
      </div>
      {recs.length === 0 ? (
        <p className="empty">{state.recFetchedAt ? 'Nothing to recommend yet. Thumb up a few series you like and refresh.' : 'No recommendations fetched yet.'}</p>
      ) : (
        <div className="grid">
          {recs.map((r) => (
            <div key={r.meta.anilistId} className="card rec">
              <a href={r.meta.anilistUrl} target="_blank" rel="noreferrer" title="Open on AniList">
                {r.meta.coverUrl ? <img className="cover" src={r.meta.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="cover ph">{displayTitle(r.meta)}</div>}
              </a>
              <div className="title">{displayTitle(r.meta)}</div>
              <div className="ch">{[r.meta.format, r.meta.year, r.meta.totalChapters && `${r.meta.totalChapters} ch`, r.meta.communityScore && `rated ${r.meta.communityScore}%`].filter(Boolean).join(' · ')}</div>
              <div className="ch because" title={r.because.join(', ')}>Because you read {r.because.join(', ')}</div>
              <div className="row">
                <button onClick={() => call('addPlanned', r.meta)}>Add to Planning</button>
                <button title="Don't suggest this again" onClick={() => call('dismissRec', r.meta.anilistId)}>Not interested</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** "Ch. 52 / 180 · 29%". For a series still coming out, the second number is what's released so far. */
function Chapters({ s }: { s: ViewSeries }) {
  const max = maxChapters(s);
  if (!max) return <>Ch. {s.progress}</>;
  const final = !!s.totalChapters;
  return (
    <span title={final ? `${max} chapters in total` : `${max} chapters released so far; still coming out`}>
      Ch. {s.progress} / {max}{final ? '' : '+'} · <b>{percentRead(s)}%</b>
    </span>
  );
}

/** Tab in an empty field fills in its greyed-out suggestion instead of moving on. */
function acceptHint(e: KeyboardEvent, value: string, set: (v: string) => void, hint?: string) {
  if (e.key !== 'Tab' || e.shiftKey || value || !hint) return;
  e.preventDefault();
  set(hint);
}

function setupSkipped() {
  try { return localStorage.getItem('setupDone') === '1'; } catch { return false; }
}
function markSetupDone() {
  try { localStorage.setItem('setupDone', '1'); } catch { /* storage blocked: setup just shows again on an empty library */ }
}

const STEPS = ['Library folder', 'Chrome account', 'Sites you read on', 'Done'];

function Setup({ state, call, error, clearError, finish }: {
  state: AppState; call: Call; error?: string; clearError: () => void; finish: (review?: boolean) => void;
}) {
  const lib = state.library;
  const [step, setStep] = useState(lib ? 1 : 0);
  const [folder, setFolder] = useState('');
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [profile, setProfile] = useState(state.historyPath ?? '');
  const [sites, setSites] = useState(lib?.settings.trackedSites.join('\n') ?? '');
  const [working, setWorking] = useState(false);

  useEffect(() => { void call('profiles').then((p) => setProfiles(p ?? [])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!profile && profiles?.length) setProfile((profiles.find((p) => p.label.startsWith('Chrome')) ?? profiles[0]).path);
  }, [profiles, profile]);
  // The folder step is finished once the server reports an open library.
  useEffect(() => { if (lib && step === 0) setStep(1); }, [lib, step]);

  const go = (n: number) => { clearError(); setStep(n); };
  const hint = state.suggestedLibrary ?? '';
  const useFolder = () => { clearError(); void call('chooseLibrary', folder.trim() || hint); };
  const siteList = sites.split(/\s+/).filter(Boolean);
  const runImport = async () => {
    clearError();
    setWorking(true);
    await call('setConfig', { historyPath: profile || undefined });
    await call('setSettings', { trackedSites: siteList });
    if (profile) await call('scan', true);
    setWorking(false);
    setStep(3);
  };
  const phones = state.devices.filter((d) => d.kind === 'phone');

  return (
    <div className="welcome setup">
      <h1>Manga Tracker</h1>
      <ol className="steps">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'on' : i < step ? 'past' : ''}>{s}</li>)}
      </ol>

      {step === 0 && (
        <>
          <h2>Where should your library be kept?</h2>
          <p>
            Your list, covers and reading log are saved in this folder as plain files, so they stay usable without this
            app. Nothing exists yet — the folder is created for you.
          </p>
          <div className="row">
            <input
              className="grow" autoFocus value={folder} placeholder={hint}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => { acceptHint(e, folder, setFolder, hint); if (e.key === 'Enter') useFolder(); }}
            />
            <button className="primary" onClick={useFolder}>{folder.trim() ? 'Use this folder' : `Use ${hint}`}</button>
          </div>
          <p className="muted">Press Tab to fill in the suggestion, or type the full path of another folder. If you already have a library folder, enter its path to open it.</p>
        </>
      )}

      {step === 1 && (
        <>
          <h2>Which Chrome account does your phone use?</h2>
          <p>
            Your phone's reading reaches this PC through Chrome sync. Pick the account on this PC that is signed in to
            the same Google account as Chrome on your phone.
          </p>
          {profiles === null ? <p className="muted">Looking for browsers…</p> : profiles.length === 0 ? (
            <p className="warn">No Chrome, Brave or Edge history was found on this PC. You can still track by hand and set this up later in Settings.</p>
          ) : (
            <div className="choices">
              {profiles.map((p) => (
                <label key={p.path} className="check">
                  <input type="radio" name="profile" checked={profile === p.path} onChange={() => setProfile(p.path)} />
                  {p.label}
                </label>
              ))}
              <label className="check">
                <input type="radio" name="profile" checked={profile === ''} onChange={() => setProfile('')} />
                None — I'll update chapters by hand
              </label>
            </div>
          )}
          <p className="muted">
            On the phone, check Chrome → Settings → your account → Sync has History and Open Tabs turned on. Chrome
            must be running on this PC for new reading to arrive.
          </p>
          <div className="row end">
            <button className="primary" onClick={() => go(2)}>Next</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h2>Which sites do you read on?</h2>
          <p>One per line. Only pages on these sites are ever read from your browser history; everything else is ignored.</p>
          <textarea
            rows={4} autoFocus value={sites} placeholder={SITES_HINT}
            onChange={(e) => setSites(e.target.value)}
            onKeyDown={(e) => acceptHint(e, sites, setSites, SITES_HINT)}
          />
          <p className="muted">Press Tab to fill in the suggestion. You can change this list later in Settings.</p>
          <div className="row end">
            <button onClick={() => go(1)}>Back</button>
            <button className="primary" disabled={working || !siteList.length} onClick={runImport}>
              {working ? 'Importing…' : profile ? 'Import my reading' : 'Next'}
            </button>
          </div>
        </>
      )}

      {step === 3 && lib && (
        <>
          <h2>{lib.pending.length ? `Found ${lib.pending.length} series` : 'Setup finished'}</h2>
          {lib.pending.length > 0 ? (
            <p>
              They came from your history, open tabs and bookmarks on the sites you listed. Each one needs matching to
              AniList once so it gets a cover and details — Review lets you match them one by one or all at once.
            </p>
          ) : (
            <p>{profile ? 'Nothing was found on those sites yet. New chapters you read will show up within a few minutes while Chrome is open on this PC.' : 'Add series with the Add button and bump chapters with +1.'}</p>
          )}
          {profile && (state.phoneIssue
            ? <p className="warn">{state.phoneIssue}</p>
            : phones.length > 0 && <p className="muted">Phone detected: {phones.map((d) => d.name || d.model).join(', ')}.</p>)}
          <p className="muted">
            From here on the tracker checks every few minutes. Connecting an AniList account is optional and lives in
            Settings, along with importing a site's own bookmark list.
          </p>
          <div className="row end">
            {lib.pending.length > 0 && <button className="primary" onClick={() => finish(true)}>Review matches</button>}
            <button className={lib.pending.length ? '' : 'primary'} onClick={() => finish()}>Open my library</button>
          </div>
        </>
      )}

      {error && <p className="err">{error}</p>}
      {lib && step < 3 && <p><button className="tab" onClick={() => finish()}>Skip setup</button></p>}
    </div>
  );
}

function Cover({ s }: { s: ViewSeries }) {
  const [failed, setFailed] = useState<string>();
  // no-referrer: MangaDex swaps covers for a placeholder when they're requested from another site.
  return s.coverSrc && failed !== s.coverSrc ? (
    <img className="cover" src={s.coverSrc} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(s.coverSrc)} />
  ) : (
    <div className="cover ph">{displayTitle(s)}</div>
  );
}

/** A warning when the series itself has stopped coming out, or you dropped it. */
function StoppedBadge({ s }: { s: ViewSeries }) {
  if (s.pubStatus === 'CANCELLED') return <span className="badge stop" title="The publisher cancelled this series; no more chapters are coming">Dropped</span>;
  if (s.status === 'DROPPED') return <span className="badge stop" title="You marked this as dropped">Dropped</span>;
  if (s.pubStatus === 'HIATUS') return <span className="badge hiatus" title="This series is on hiatus">On hiatus</span>;
  return null;
}

function Sheet({ title, close, wide, children }: { title: string; close: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={wide ? 'sheet wide' : 'sheet'}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button onClick={close}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Detail({ s, all, dead, call, close, open }: { s: ViewSeries; all: ViewSeries[]; dead?: string[]; call: Call; close: () => void; open: (id: string) => void }) {
  const [options, setOptions] = useState<SiteOption[] | 'loading' | null>(null);
  const [chapter, setChapter] = useState(String(s.progress));
  const [readAt, setReadAt] = useState(s.readAt ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const [finding, setFinding] = useState(false);
  const [merging, setMerging] = useState(false);
  useEffect(() => setChapter(String(s.progress)), [s.progress]);
  const upd = (patch: object) => call('updateSeries', s.id, patch);
  const next = nextLink(s, dead);
  const link = next.url;
  const findSites = async () => {
    if (options) return setOptions(null);
    setOptions('loading');
    setOptions((await call('findElsewhere', s.id)) ?? null);
  };
  const useOption = (o: SiteOption) => {
    void call('openExternal', o.url);
    // Remember a real page as the new place to read; a search result page is not one.
    if (o.kind !== 'search') {
      setReadAt(o.url);
      void upd({ readAt: o.url });
    }
  };
  return (
    <Sheet title={displayTitle(s)} close={close} wide>
      <div className="detail">
        <Cover s={s} />
        <div className="info">
          <div className="muted">
            {[s.siteTitle, s.titles.romaji, s.titles.native].filter((t, i, all) => t && t.toLowerCase() !== displayTitle(s).toLowerCase() && all.indexOf(t) === i).join(' · ')}
          </div>
          <div className="muted">
            {[kindLabel(s), s.year, s.pubStatus?.toLowerCase().replace(/_/g, ' '), s.authors?.join(', ')].filter(Boolean).join(' · ')}
          </div>
          {s.genres?.length ? <div className="muted">{s.genres.join(', ')}</div> : null}
          <div className="row">
            <Thumbs s={s} call={call} />
            <span className="muted">{s.lastReadAt ? `Last read ${new Date(s.lastReadAt).toLocaleString()}` : 'Last read: not known'}</span>
          </div>
          {s.pubStatus === 'CANCELLED' && <div className="warn">This series was dropped by its publisher. No more chapters are coming.</div>}
          {s.pubStatus === 'HIATUS' && <div className="warn">This series is on hiatus.</div>}
          {s.source === 'mangadex' && <div className="muted">Details from MangaDex (not on AniList)</div>}
          {s.source === 'mangaupdates' && <div className="muted">Details from MangaUpdates (not on AniList or MangaDex)</div>}
          {s.needsDetails && (
            <div className="bar inline">
              No source has details for this yet, so it only has the name from your reading site.
              <span>
                <button onClick={() => setFinding(!finding)}>Find details</button>
                <button title="Look everything without details up again on AniList and MangaDex" onClick={() => call('autoMatch')}>Retry all</button>
              </span>
            </div>
          )}
          {finding && s.needsDetails && (
            <SearchResults call={call} initial={displayTitle(s)} onPick={(m) => { void call('setDetails', s.id, m); setFinding(false); }} />
          )}
          {s.origin === 'bookmark' && (
            <div className="bar inline">
              From a bookmark only, not confirmed by your reading history.
              <button onClick={() => upd({ promote: true })}>Move to Reading</button>
            </div>
          )}
          {next.gone && (
            <div className="bar inline">
              {hostOf(link)} has closed or moved, so the saved link no longer works.
              <button className="primary" onClick={findSites}>Find another site</button>
            </div>
          )}
          {options === 'loading' && <p className="muted">Looking on the sites you read on…</p>}
          {Array.isArray(options) && (
            <div className="merge">
              {options.map((o) => (
                <button key={o.url} className="mergeRow" onClick={() => useOption(o)}>
                  <span><b>{o.site}</b> · {o.note}</span>
                  <small>{o.kind === 'found' ? 'Checked ✓' : o.kind === 'guess' ? 'Not checked' : 'Search'}</small>
                </button>
              ))}
              <p className="muted">Opening a site link also saves it under "Read at". Once you read a chapter there, the tracker follows that site by itself.</p>
            </div>
          )}
          <div className="row">
            <button onClick={() => upd({ progress: Math.max(0, Math.floor(s.progress) - 1) })}>−1</button>
            <input
              className="num"
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              onBlur={() => chapter.trim() !== '' && Number(chapter) !== s.progress && upd({ progress: Number(chapter) })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="muted">
              {maxChapters(s)
                ? `/ ${maxChapters(s)} ${s.totalChapters ? 'chapters' : 'released so far'} · ${percentRead(s)}% read`
                : 'chapters (total not known)'}
            </span>
            <button onClick={() => upd({ progress: Math.floor(s.progress) + 1 })}>+1</button>
            <select value={s.status} onChange={(e) => upd({ status: e.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={s.score ?? 0} onChange={(e) => upd({ score: Number(e.target.value) })}>
              <option value={0}>No score</option>
              {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} / 10</option>)}
            </select>
          </div>
          <label>Read at (local only)</label>
          <input value={readAt} placeholder="https://…" onChange={(e) => setReadAt(e.target.value)} onBlur={() => readAt !== (s.readAt ?? '') && upd({ readAt })} />
          <label>Notes</label>
          <textarea value={notes} rows={3} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (s.notes ?? '') && upd({ notes })} />
          <div className="row">
            {link && !next.gone && <button className="primary" onClick={() => call('openExternal', link)}>{next.chapter ? `Read chapter ${next.chapter}` : 'Continue reading'}</button>}
            {!next.gone && <button title="Find this series on the other sites you read on, or search the web for it" onClick={findSites}>Other sites…</button>}
            {s.anilistUrl && <button onClick={() => call('openExternal', s.anilistUrl)}>Open on AniList</button>}
            <span className="grow" />
            <button title="This is the same series as another entry in your library" onClick={() => setMerging(!merging)}>Merge…</button>
            <button
              className="danger"
              onClick={() => {
                if (confirm(`Remove "${displayTitle(s)}" from this library? It is not removed from AniList.`)) {
                  void call('removeSeries', s.id);
                  close();
                }
              }}
            >
              Remove
            </button>
          </div>
          {merging && (
            <MergePicker
              s={s}
              all={all}
              onMerge={async (other, opts) => {
                const kept = await call('mergeSeries', s.id, other.id, opts);
                setMerging(false);
                if (kept && kept !== s.id) open(kept);
              }}
            />
          )}
          {s.description && <p className="desc">{s.description}</p>}
        </div>
      </div>
    </Sheet>
  );
}

/** Pick the other library entry that is the same series. Likely duplicates (shared words in the name) are listed first. */
type MergeOpts = { detailsFrom: string; progress: number; status: Status };

function MergePicker({ s, all, onMerge }: { s: ViewSeries; all: ViewSeries[]; onMerge: (other: ViewSeries, opts: MergeOpts) => void }) {
  const [q, setQ] = useState('');
  const [other, setOther] = useState<ViewSeries | null>(null);
  const [opts, setOpts] = useState<MergeOpts | null>(null);
  const onPick = (o: ViewSeries) => {
    setOther(o);
    // Start from the sensible answers: the entry with real details, the higher chapter, the status of the one you actually read.
    const better = (s.needsDetails || !s.anilistId) && o.anilistId ? o : s;
    setOpts({ detailsFrom: better.id, progress: Math.max(s.progress, o.progress), status: s.origin === 'bookmark' && !o.origin ? o.status : s.status });
  };
  const words = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const mine = words([displayTitle(s), s.siteTitle ?? '', s.titles.romaji ?? ''].join(' '));
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((o) => o.id !== s.id)
      .map((o) => {
        const names = [displayTitle(o), o.siteTitle ?? '', o.titles.romaji ?? '', ...(o.altTitles ?? [])].join(' ');
        const theirs = words(names);
        let shared = 0;
        for (const w of mine) if (theirs.has(w)) shared++;
        return { o, names: names.toLowerCase(), like: mine.size ? shared / mine.size : 0 };
      })
      .filter((x) => (needle ? x.names.includes(needle) : x.like >= 0.5))
      .sort((a, b) => b.like - a.like || displayTitle(a.o).localeCompare(displayTitle(b.o)))
      .slice(0, 8);
  }, [all, s.id, q]);
  if (other && opts) {
    const pair = [s, other];
    const differentSeries = !!s.anilistId && !!other.anilistId && s.anilistId !== other.anilistId;
    const choice = <T,>(label: string, values: T[], current: T, show: (v: T, i: number) => string, set: (v: T) => void) => (
      <div className="mergeChoice">
        <span className="muted">{label}</span>
        {values[0] === values[1]
          ? <span>{show(values[0], 0)} <small className="muted">(same on both)</small></span>
          : values.map((v, i) => (
            <label key={i} className={current === v ? 'opt on' : 'opt'}>
              <input type="radio" checked={current === v} onChange={() => set(v)} /> {show(v, i)}
            </label>
          ))}
      </div>
    );
    return (
      <div className="merge">
        <b>Choose what to keep</b>
        {differentSeries && <div className="warn">These are two different series on AniList, so they can't be merged.</div>}
        {choice('Name, cover and details', pair.map((x) => x.id), opts.detailsFrom,
          (_, i) => `${displayTitle(pair[i])}${pair[i].needsDetails ? ' (no details)' : pair[i].anilistId ? ' (AniList)' : ''}`,
          (v) => setOpts({ ...opts, detailsFrom: v }))}
        {choice('Chapter', pair.map((x) => x.progress), opts.progress, (v) => `Ch. ${v}`, (v) => setOpts({ ...opts, progress: v }))}
        {choice('Status', pair.map((x) => x.status), opts.status, (v, i) => `${STATUS_LABEL[v]}${pair[i].origin === 'bookmark' ? ' (bookmark only)' : ''}`, (v) => setOpts({ ...opts, status: v }))}
        <div className="muted">Always combined: the sites you read it on, notes, your thumb and score, and reading stats.</div>
        <div className="row">
          <button className="primary" disabled={differentSeries} onClick={() => onMerge(other, opts)}>Merge into one entry</button>
          <button onClick={() => { setOther(null); setOpts(null); }}>Back</button>
        </div>
      </div>
    );
  }
  return (
    <div className="merge">
      <input autoFocus value={q} placeholder="Type the name of the other entry" onChange={(e) => setQ(e.target.value)} />
      {list.length === 0 && <div className="muted">{q.trim() ? 'No entry with that name.' : 'No likely duplicates found. Type a name to search your library.'}</div>}
      {list.map(({ o }) => (
        <button key={o.id} className="mergeRow" onClick={() => onPick(o)}>
          <span>{displayTitle(o)}</span>
          <small>{[STATUS_LABEL[o.status], `ch. ${o.progress}`, o.origin === 'bookmark' && 'bookmark', o.needsDetails && 'no details'].filter(Boolean).join(' · ')}</small>
        </button>
      ))}
    </div>
  );
}

function SearchResults({ call, initial, onPick }: { call: Call; initial?: string; onPick: (m: SeriesMeta) => void }) {
  const [q, setQ] = useState(initial ?? '');
  const [hits, setHits] = useState<(SeriesMeta & { synonyms?: string[] })[] | null>(null);
  const [loading, setLoading] = useState(false);
  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setHits((await call('search', q.trim())) ?? []);
    setLoading(false);
  };
  useEffect(() => { if (initial) void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="row">
        <input className="grow" autoFocus value={q} placeholder="Search AniList…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <button onClick={run}>Search</button>
      </div>
      {loading && <p className="muted">Searching…</p>}
      {hits?.length === 0 && !loading && <p className="muted">No results.</p>}
      <div className="hits">
        {hits?.map((h) => {
          const { synonyms: _s, ...meta } = h;
          return (
            <button key={h.anilistId} className="hit" onClick={() => onPick(meta)}>
              {h.coverUrl ? <img src={h.coverUrl} alt="" referrerPolicy="no-referrer" /> : <span className="hit-ph" />}
              <span>
                <b>{displayTitle(h)}</b>
                <small>{[h.titles.romaji, h.format, h.year, h.totalChapters && `${h.totalChapters} ch`].filter(Boolean).join(' · ')}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Add({ call, close }: { call: Call; close: () => void }) {
  const [title, setTitle] = useState('');
  return (
    <Sheet title="Add a series" close={close}>
      <SearchResults call={call} onPick={(m) => { void call('addSeries', m); close(); }} />
      <label>Not on AniList? Add it as a local-only entry</label>
      <div className="row">
        <input className="grow" value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
        <button disabled={!title.trim()} onClick={() => { void call('addLocal', title); close(); }}>Add local</button>
      </div>
    </Sheet>
  );
}

function Pending({ state, call, close }: { state: AppState; call: Call; close: () => void }) {
  const lib = state.library!;
  const [searching, setSearching] = useState<string | null>(null);
  const sorted = [...lib.series].sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
  const resolve = (p: PendingMatch, action: object) => call('resolvePending', p.key, action);
  return (
    <Sheet title={`Match series (${lib.pending.length})`} close={close} wide>
      <p className="muted">
        These were found on your tracked sites but aren't linked to a library entry yet. Ones marked “read” come from
        your history or open tabs; “bookmark only” ones go to the separate Bookmarks tab until you're seen reading them. Auto-match cleans up each name and looks it up on
        AniList, then MangaDex. Anything neither knows is kept under the site's own name, marked “No details”, and retried later.
        {state.loggedIn && lib.settings.syncEnabled && ' Matched series are also added to your AniList list on the next sync.'}
      </p>
      <div className="row">
        <button className="primary" disabled={!!state.busy} onClick={() => call('autoMatch')}>Auto-match all</button>
        {state.busy && <span className="muted">{state.busy}</span>}
      </div>
      <div className="pending">
        {lib.pending.slice(0, 60).map((p) => (
          <div key={p.key} className="pend">
            <div>
              <b>{p.titleGuess}</b> <span className="muted">ch. {p.chapter} · {p.domain}</span>{' '}
              <span className={p.source === 'bookmark' ? 'badge' : 'badge read'}>{p.source === 'bookmark' ? 'bookmark only' : 'read'}</span>
            </div>
            <div className="row">
              <button onClick={() => setSearching(searching === p.key ? null : p.key)}>Find on AniList</button>
              <select value="" onChange={(e) => e.target.value && resolve(p, { type: 'existing', seriesId: e.target.value })}>
                <option value="">Link to existing…</option>
                {sorted.map((s) => <option key={s.id} value={s.id}>{displayTitle(s)}</option>)}
              </select>
              <button onClick={() => resolve(p, { type: 'local' })}>Add local-only</button>
              <button onClick={() => resolve(p, { type: 'ignore' })}>Ignore</button>
            </div>
            {searching === p.key && (
              <SearchResults call={call} initial={p.titleGuess} onPick={(m) => { void resolve(p, { type: 'anilist', media: m }); setSearching(null); }} />
            )}
          </div>
        ))}
        {lib.pending.length > 60 && <p className="muted">…and {lib.pending.length - 60} more.</p>}
      </div>
    </Sheet>
  );
}

function Activity({ state, call, close }: { state: AppState; call: Call; close: () => void }) {
  return (
    <Sheet title="Recent activity" close={close}>
      {state.activity.length === 0 && <p className="muted">Nothing yet.</p>}
      <div className="activity">
        {state.activity.map((e, i) => (
          <div key={e.t + i} className="act">
            <span>
              <b>{e.title}</b>{' '}
              {e.field === 'progress' ? `ch. ${e.from} → ${e.to}` : e.field === 'status' ? `${e.from} → ${e.to}` : e.field}
              <small> · {e.source} · {new Date(e.t).toLocaleString()}</small>
            </span>
            {e.field === 'progress' && e.source === 'detected' && <button onClick={() => call('undo', e.t)}>Undo</button>}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const KIND_LABEL = { phone: 'Phone', tablet: 'Tablet', computer: 'Computer', other: 'Device' } as const;

function ago(ms?: number) {
  if (!ms) return 'unknown';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} minutes ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} hours ago`;
  return new Date(ms).toLocaleDateString();
}

function Devices({ state, call, close, openSettings }: { state: AppState; call: Call; close: () => void; openSettings: () => void }) {
  return (
    <Sheet title="Devices" close={close}>
      {state.phoneIssue && <p className="warn">{state.phoneIssue}</p>}
      {!state.historyPath ? (
        <>
          <p className="muted">Reading detection is off. Pick the browser profile to read in Settings and your synced devices will show here.</p>
          <button onClick={openSettings}>Open Settings</button>
        </>
      ) : (
        <>
          <p className="muted">
            Devices signed into the same browser account, as the browser on this PC last saw them. Only tabs on your
            tracked sites are shown.
          </p>
          {state.devices.length === 0 && <p className="muted">No devices found yet.</p>}
          {state.devices.map((d) => (
            <div key={d.guid} className="device">
              <div>
                <b>{d.name}</b>{' '}
                <span className="muted">
                  {KIND_LABEL[d.kind]}{d.model && d.kind === 'computer' && d.model !== d.name ? ` · ${d.model}` : ''} · last seen {ago(d.lastSeen)}
                </span>
              </div>
              {d.tabs.length === 0 ? (
                <div className="muted">No open tabs on tracked sites.</div>
              ) : (
                d.tabs.slice(0, 12).map((t, i) => (
                  <button key={t.url + i} className="tablink" title={t.url} onClick={() => call('openExternal', t.url)}>
                    {t.title} <small>{t.lastActive ? ago(t.lastActive) : ''}</small>
                  </button>
                ))
              )}
              {d.tabs.length > 12 && <div className="muted">…and {d.tabs.length - 12} more tabs.</div>}
            </div>
          ))}
          <div className="row">
            <button onClick={() => call('scan')}>Check again</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-14" -> "Sat 14 Nov" */
function niceDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return `${DAY_NAMES[new Date(y, m - 1, d).getDay()]} ${d} ${MONTH_NAMES[m - 1]}`;
}

function Bars({ items }: { items: { label: string; tip: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i, n) => (
        <div key={n} className="barcol" title={`${i.tip}: ${i.value} chapter${i.value === 1 ? '' : 's'}`}>
          <span className="barval">{i.value || ''}</span>
          <div className="barfill" style={{ height: `${(i.value / max) * 100}%` }} />
          <span className="barlabel">{i.label}</span>
        </div>
      ))}
    </div>
  );
}

function Stats({ call, close, open }: { call: Call; close: () => void; open: (id: string) => void }) {
  const [st, setSt] = useState<ReadingStats | null>(null);
  useEffect(() => { void call('stats').then((r) => setSt(r ?? null)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return <Sheet title="Reading stats" close={close}><p className="muted">Counting…</p></Sheet>;
  const topMax = Math.max(1, ...st.top.map((t) => t.chapters));
  return (
    <Sheet title="Reading stats" close={close}>
      {st.total === 0 ? (
        <p className="muted">Nothing counted yet. Chapters show up here once the tracker has seen you open them in the browser.</p>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><b>{st.today}</b><span>today</span></div>
            <div className="tile"><b>{st.last7}</b><span>last 7 days</span></div>
            <div className="tile"><b>{st.last30}</b><span>last 30 days</span></div>
            <div className="tile"><b>{(st.last30 / 30).toFixed(1)}</b><span>a day on average</span></div>
            <div className="tile"><b>{st.activeDays30}</b><span>days read, of 30</span></div>
            <div className="tile"><b>{st.streak}</b><span>day streak</span></div>
          </div>
          <h3>Chapters per day, last 30 days</h3>
          <Bars items={st.days.map((d, i) => ({ label: i % 5 === 4 || i === 0 ? String(Number(d.day.slice(8))) : '', tip: niceDay(d.day), value: d.chapters }))} />
          <h3>Chapters per week, last 12 weeks</h3>
          <Bars items={st.weeks.map((w) => ({ label: `${Number(w.start.slice(8))} ${MONTH_NAMES[Number(w.start.slice(5, 7)) - 1]}`, tip: `Week of ${niceDay(w.start)}`, value: w.chapters }))} />
          {st.months.length > 1 && (
            <>
              <h3>Chapters per month</h3>
              <Bars items={st.months.map((m) => ({ label: `${MONTH_NAMES[Number(m.month.slice(5)) - 1]} ${m.month.slice(2, 4)}`, tip: `${MONTH_NAMES[Number(m.month.slice(5)) - 1]} ${m.month.slice(0, 4)}`, value: m.chapters }))} />
            </>
          )}
          <h3>Most read, last 30 days ({st.seriesRead30} series)</h3>
          <div className="toplist">
            {st.top.map((t) => (
              <div key={t.id ?? t.title} className="toprow" onClick={() => t.id && open(t.id)}>
                <span className="topname">{t.title}</span>
                <span className="topbar"><i style={{ width: `${(t.chapters / topMax) * 100}%` }} /></span>
                <span className="topnum">{t.chapters}</span>
              </div>
            ))}
          </div>
          <p className="muted">
            {st.total} chapters counted since {st.since && niceDay(st.since)} {st.since?.slice(0, 4)}
            {st.best && `; busiest day ${niceDay(st.best.day)} with ${st.best.chapters}`}.
            {st.unnamed30 > 0 && ` ${st.unnamed30} chapters in the last 30 days are from hidden or unmatched series.`}
          </p>
          <p className="muted">
            Counted from the real date of each chapter page you opened; a chapter counts once. Chapters you had already
            read before the tracker could see them (your starting chapter numbers, your AniList list) are not counted,
            and the browser only keeps about three months of history, so the chart starts there.
          </p>
        </>
      )}
    </Sheet>
  );
}

function Settings({ state, call, error, close, runSetup }: { state: AppState; call: Call; error?: string; close: () => void; runSetup: () => void }) {
  const lib = state.library!;
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [sites, setSites] = useState(lib.settings.trackedSites.join('\n'));
  const [clientId, setClientId] = useState(state.clientId ?? '');
  const [token, setToken] = useState('');
  useEffect(() => { void call('profiles').then((p) => setProfiles(p ?? [])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveSites = () => call('setSettings', { trackedSites: sites.split(/\s+/).filter(Boolean) });
  const [importMsg, setImportMsg] = useState('');
  const extras = state.extraSources ?? [];
  const [inbox, setInbox] = useState(state.inboxPath ?? '');
  const [backupMsg, setBackupMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const saveBackup = async () => {
    const b = (await call('backup')) as Backup | undefined;
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
    a.download = `manga-tracker-backup-${b.savedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setBackupMsg(`Saved ${b.library.series.length} series to ${a.download} in your Downloads folder.`);
  };
  const restoreBackup = async (file?: File) => {
    if (!file) return;
    let b: Backup;
    try {
      b = JSON.parse(await file.text());
    } catch {
      setBackupMsg('That file could not be read as a backup.');
      return;
    }
    const n = b?.library?.series?.length;
    if (b?.app !== 'manga-tracker-backup' || typeof n !== 'number') {
      setBackupMsg('That file is not a Manga Tracker backup.');
      return;
    }
    if (!confirm(`Replace the library you have now (${lib.series.length + state.hiddenNsfw} series) with this backup from ${new Date(b.savedAt).toLocaleString()} (${n} series)?\n\nThe current library is kept in the backups folder first.`)) return;
    const r = await call('restore', b);
    if (r) setBackupMsg(`Restored ${r.series} series. The library from before is in ${r.kept}.`);
  };
  // A page copied with Ctrl+A / Ctrl+C keeps its links in the clipboard's HTML form.
  const importHtml = async (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = [...doc.querySelectorAll('a[href]')]
      .map((a) => ({ url: a.getAttribute('href') ?? '', title: (a.textContent ?? '').trim() }))
      .filter((l) => /^https?:\/\//i.test(l.url));
    if (!links.length) {
      setImportMsg('No links found in what you pasted. Copy the page itself (Ctrl+A, Ctrl+C), not its address.');
      return;
    }
    await saveSites();
    const r = await call('importLinks', links);
    if (!r) return;
    setImportMsg(
      r.links === 0
        ? `That page had ${links.length} links, but none on your tracked sites.`
        : `Found ${r.series} series on tracked sites (${r.added} new). New ones are waiting under Review and go to the Bookmarks tab.`,
    );
  };
  return (
    <Sheet title="Settings" close={close}>
      <h3>Library</h3>
      <p className="muted path">{state.libraryPath}</p>
      <div className="row">
        <button onClick={() => call('openFolder')}>Open folder</button>
        <button
          onClick={() => {
            const p = prompt('Full path of the library folder to use', state.libraryPath ?? '');
            if (p?.trim()) void call('chooseLibrary', p);
          }}
        >
          Change…
        </button>
        <button onClick={() => call('exportCsv')}>Export CSV</button>
        <button title="Save the whole library, reading history and stats to one file" onClick={saveBackup}>Save backup</button>
        <button title="Replace this library with a backup file, here or on another PC" onClick={() => fileRef.current?.click()}>Restore backup…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { void restoreBackup(e.target.files?.[0]); e.target.value = ''; }} />
        <button onClick={runSetup}>Run setup again</button>
        <button title="Timings for matching, cover downloads and history checks" onClick={() => call('openLog')}>Open log</button>
      </div>
      {backupMsg && <p className="muted">{backupMsg}</p>}
      <label className="check">
        <input type="checkbox" checked={lib.settings.downloadImages === true} onChange={(e) => call('setSettings', { downloadImages: e.target.checked })} />
        Download cover images from AniList into the library folder
      </label>

      <label className="check">
        <input type="checkbox" checked={lib.settings.useMangadex !== false} onChange={(e) => call('setSettings', { useMangadex: e.target.checked })} />
        Use MangaDex as a backup when AniList doesn't have a series (unmatched titles are sent there too)
      </label>
      <label className="check">
        <input type="checkbox" checked={lib.settings.useMangaUpdates !== false} onChange={(e) => call('setSettings', { useMangaUpdates: e.target.checked })} />
        Use MangaUpdates for novels and for how many chapters are out (titles are sent there too)
      </label>
      <div className="row">
        <button title="Look up how many chapters are out for every series that has no final count" onClick={() => call('refreshChapters')}>Check chapter counts now</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={state.autostart} onChange={(e) => call('setAutostart', e.target.checked)} />
        Start with Windows, quietly in the background (no window; open the tracker from its shortcut when you want it)
      </label>
      <p className="muted">
        In the background it looks for new reading every 5 minutes, and that check is skipped entirely unless the
        browser has saved something new. AniList is fetched once an hour, chapter counts and recommendations once a week.
      </p>

      <h3>Reading detection</h3>
      <label>Browser history to read</label>
      <select value={state.historyPath ?? ''} onChange={(e) => call('setConfig', { historyPath: e.target.value || undefined })}>
        <option value="">Off</option>
        {profiles.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
      </select>
      <label>Tracked sites (one per line) — only these are ever read from the history</label>
      <textarea rows={3} value={sites} placeholder={SITES_HINT} onChange={(e) => setSites(e.target.value)} onKeyDown={(e) => acceptHint(e, sites, setSites, SITES_HINT)} onBlur={saveSites} />
      <div className="row">
        <button disabled={!state.historyPath} onClick={async () => { await saveSites(); await call('scan'); }}>Check now</button>
        <button disabled={!state.historyPath} onClick={async () => { await saveSites(); await call('scan', true); }}>Import full history + bookmarks</button>
      </div>
      {!state.historyPath && <p className="warn">Nothing is being read yet: "Browser history to read" above is Off. Pick your Chrome account there first.</p>}
      {state.busy && <p className="muted">{state.busy}</p>}
      <label>Other browsers <span className="badge">beta</span></label>
      <p className="muted">
        Read these as well as the one above. A phone browser arrives through its PC version: reading in Edge, Brave or Firefox on your
        phone shows up here once the same browser on this PC is signed in to sync history.
      </p>
      {profiles.filter((p) => p.path !== state.historyPath).length === 0
        ? <p className="muted">No other browsers found on this PC.</p>
        : profiles.filter((p) => p.path !== state.historyPath).map((p) => (
          <label key={p.path} className="check">
            <input
              type="checkbox"
              checked={extras.includes(p.path)}
              onChange={(e) => call('setSources', { extraSources: e.target.checked ? [...extras, p.path] : extras.filter((x) => x !== p.path) })}
            /> {p.label}
          </label>
        ))}
      <label>Inbox file for Safari and anything else <span className="badge">beta</span></label>
      <p className="muted">
        Safari's history can't be read from Windows. Instead, a share-sheet Shortcut on the phone adds the page you're on to a text file
        that syncs to this PC, and the tracker reads new lines from it. <a href="#" onClick={(e) => { e.preventDefault(); void call('openDoc', 'other-browsers.md'); }}>Step-by-step setup</a>.
      </p>
      <div className="row">
        <input className="grow" value={inbox} placeholder="Full path of the synced text file, e.g. …\iCloudDrive\Shortcuts\manga-inbox.txt" onChange={(e) => setInbox(e.target.value)} />
        <button disabled={inbox.trim() === (state.inboxPath ?? '')} onClick={() => call('setSources', { inboxPath: inbox })}>Save</button>
      </div>
      {error && <p className="err">{error}</p>}
      <label>Import a site's own bookmark list (for example mangahub.io/user/bookmarks)</label>
      <div
        className="paste"
        tabIndex={0}
        onPaste={(e) => {
          e.preventDefault();
          void importHtml(e.clipboardData.getData('text/html'));
        }}
      >
        Open the page while signed in, press Ctrl+A then Ctrl+C, click this box and press Ctrl+V. Repeat for each page of
        the list.
      </div>
      <div className="row">
        <span className="muted">or a saved page:</span>
        <input
          type="file"
          accept=".html,.htm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await importHtml(await f.text());
            e.target.value = '';
          }}
        />
      </div>
      {importMsg && <p className="muted">{importMsg}</p>}
      <p className="muted">
        Phone reading shows up here only after the same browser has synced on this PC, so it needs to be open (or
        running in the background) now and then.
      </p>

      <h3>AniList</h3>
      {state.loggedIn ? (
        <div className="row">
          <span>Connected as <b>{state.viewerName}</b></span>
          <button onClick={() => call('sync')}>Sync now</button>
          <button onClick={() => call('logout')}>Disconnect</button>
        </div>
      ) : (
        <>
          <ol className="steps">
            <li>
              <button onClick={() => window.open('https://anilist.co/settings/developer', '_blank', 'noopener')}>Open AniList's Developer page</button>{' '}
              and sign in if it asks. (On the site: your avatar → Settings → Developer.)
            </li>
            <li>Click <b>Create New Client</b>. Name: anything, for example "Manga Tracker".</li>
            <li>
              Redirect URL: paste exactly <code>https://anilist.co/api/v2/oauth/pin</code>{' '}
              <button onClick={() => navigator.clipboard.writeText('https://anilist.co/api/v2/oauth/pin')}>Copy</button>, then click <b>Save</b>.
            </li>
            <li>AniList now shows the client's <b>ID</b>, a short number. Type it in the box below. (The long "Secret" is not needed.)</li>
            <li>Click <b>Open AniList to authorize</b>, then <b>Authorize</b> on the page that opens.</li>
            <li>AniList shows a very long block of text: that is the token. Copy all of it, paste it in the second box, and click <b>Connect</b>.</li>
          </ol>
          <p className="muted">
            The token lasts a year and is stored encrypted on this PC only. "Invalid token" means part of it was missed
            when copying: click inside the block on AniList, press Ctrl+A, Ctrl+C, and paste again. The same steps with
            pictures of what to look for are in <code>docs/anilist-setup.md</code> in the app's folder.
          </p>
          <div className="row">
            <input value={clientId} placeholder="Client ID" onChange={(e) => setClientId(e.target.value)} onBlur={() => call('setConfig', { clientId: clientId.trim() })} />
            <button
              disabled={!/^\d+$/.test(clientId.trim())}
              onClick={() => {
                window.open(`https://anilist.co/api/v2/oauth/authorize?client_id=${clientId.trim()}&response_type=token`, '_blank', 'noopener');
                void call('setConfig', { clientId: clientId.trim() });
              }}
            >
              Open AniList to authorize
            </button>
          </div>
          <div className="row">
            <input className="grow" type="password" value={token} placeholder="Paste the token AniList shows you" onChange={(e) => setToken(e.target.value)} />
            <button className="primary" disabled={!token.trim()} onClick={async () => { await call('login', token); setToken(''); }}>Connect</button>
          </div>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={lib.settings.syncEnabled} onChange={(e) => call('setSettings', { syncEnabled: e.target.checked })} />
        Keep AniList in sync (off = fully local)
      </label>
    </Sheet>
  );
}
