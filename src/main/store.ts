import fs from 'node:fs';
import path from 'node:path';
import {
  displayTitle,
  type HistoryEvent,
  type Library,
  type Series,
  type SeriesMeta,
  type Status,
} from '../shared/types';
import { renderStaticPage } from './staticPage';

const BACKUP_KEEP = 10;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const ACTIVITY_KEEP = 100;

function emptyLibrary(): Library {
  return {
    schemaVersion: 1,
    settings: { downloadImages: null, syncEnabled: true, trackedSites: [], siteOverrides: {} },
    siteMappings: {},
    ignored: [],
    pending: [],
    series: [],
  };
}

/** The library folder: library.json, history.jsonl, covers/, backups/, index.html. */
export class Store {
  lib: Library;
  activity: HistoryEvent[] = [];
  private lastBackup = 0;

  constructor(readonly dir: string) {
    fs.mkdirSync(path.join(dir, 'covers'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    if (fs.existsSync(this.libFile)) {
      const raw = JSON.parse(fs.readFileSync(this.libFile, 'utf8')) as Partial<Library>;
      if (raw.schemaVersion !== 1) throw new Error(`Unsupported library schemaVersion: ${raw.schemaVersion}`);
      const base = emptyLibrary();
      this.lib = { ...base, ...raw, settings: { ...base.settings, ...raw.settings } } as Library;
    } else {
      this.lib = emptyLibrary();
      this.save();
    }
    if (fs.existsSync(this.historyFile)) {
      const lines = fs.readFileSync(this.historyFile, 'utf8').trim().split('\n').slice(-ACTIVITY_KEEP);
      for (const line of lines) {
        try {
          this.activity.push(JSON.parse(line));
        } catch {
          /* skip a damaged line */
        }
      }
    }
  }

  get libFile() {
    return path.join(this.dir, 'library.json');
  }
  get historyFile() {
    return path.join(this.dir, 'history.jsonl');
  }
  coverPath(file: string) {
    return path.join(this.dir, 'covers', file);
  }

  save() {
    const now = Date.now();
    if (fs.existsSync(this.libFile) && now - this.lastBackup > BACKUP_INTERVAL_MS) {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const dir = path.join(this.dir, 'backups');
      fs.copyFileSync(this.libFile, path.join(dir, `library-${stamp}.json`));
      const old = fs.readdirSync(dir).filter((f) => f.startsWith('library-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) fs.unlinkSync(path.join(dir, f));
      this.lastBackup = now;
    }
    this.writeAtomic(this.libFile, JSON.stringify(this.lib, null, 2));
    this.writeAtomic(path.join(this.dir, 'index.html'), renderStaticPage(this.lib));
  }

  private writeAtomic(file: string, data: string) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  }

  log(ev: Omit<HistoryEvent, 't'>) {
    const full: HistoryEvent = { t: new Date().toISOString(), ...ev };
    fs.appendFileSync(this.historyFile, JSON.stringify(full) + '\n', 'utf8');
    this.activity.push(full);
    if (this.activity.length > ACTIVITY_KEEP) this.activity.shift();
  }

  get(id: string) {
    return this.lib.series.find((s) => s.id === id);
  }
  byAnilist(anilistId: number) {
    return this.lib.series.find((s) => s.anilistId === anilistId);
  }

  add(
    meta: SeriesMeta,
    init: { status?: Status; progress?: number; score?: number; readAt?: string },
    source: HistoryEvent['source'],
  ): Series {
    const existing = meta.anilistId ? this.byAnilist(meta.anilistId) : undefined;
    if (existing) return existing;
    const now = Date.now();
    const s: Series = {
      ...meta,
      id: meta.anilistId ? `al-${meta.anilistId}` : `local-${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      status: init.status ?? 'CURRENT',
      progress: init.progress ?? 0,
      score: init.score,
      readAt: init.readAt,
      addedAt: now,
      updatedAt: now,
      dirty: source !== 'anilist',
    };
    this.lib.series.push(s);
    this.log({ seriesId: s.id, title: displayTitle(s), field: 'added', to: s.progress, source });
    return s;
  }

  setProgress(s: Series, to: number, source: HistoryEvent['source'], url?: string) {
    if (s.progress === to) return;
    this.log({ seriesId: s.id, title: displayTitle(s), field: 'progress', from: s.progress, to, source, url });
    s.progress = to;
    if (source !== 'anilist') {
      s.updatedAt = Date.now();
      s.dirty = true;
    }
  }

  setStatus(s: Series, to: Status, source: HistoryEvent['source']) {
    if (s.status === to) return;
    this.log({ seriesId: s.id, title: displayTitle(s), field: 'status', from: s.status, to, source });
    s.status = to;
    if (source !== 'anilist') {
      s.updatedAt = Date.now();
      s.dirty = true;
    }
  }

  remove(id: string) {
    const s = this.get(id);
    if (!s) return;
    this.lib.series = this.lib.series.filter((x) => x.id !== id);
    for (const [k, v] of Object.entries(this.lib.siteMappings)) if (v === id) delete this.lib.siteMappings[k];
    this.log({ seriesId: id, title: displayTitle(s), field: 'removed', from: s.progress, source: 'manual' });
  }

  toCsv(): string {
    const cols = ['title', 'romaji', 'native', 'status', 'progress', 'totalChapters', 'score', 'readAt', 'anilistUrl', 'notes', 'updated', 'lastRead', 'released', 'liked'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = this.lib.series.map((s) =>
      [displayTitle(s), s.titles.romaji, s.titles.native, s.status, s.progress, s.totalChapters, s.score, s.readAt, s.anilistUrl, s.notes, new Date(s.updatedAt).toISOString(), s.lastReadAt ? new Date(s.lastReadAt).toISOString() : '', s.latestChapter, s.liked]
        .map(esc)
        .join(','),
    );
    return '﻿' + [cols.join(','), ...rows].join('\r\n');
  }
}
