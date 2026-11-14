import fs from 'node:fs';
import type { ReadingStats } from '../shared/types';

/**
 * Which chapters were read on which day, taken from the real time of each page visit.
 * A chapter counts once, on the first day it was seen. Chapters that were only ever known as a
 * number (the first import's "you are on chapter 180", an AniList list) have no visit behind
 * them and are never in here, so years of earlier reading can't land on one day.
 */
interface LogFile {
  v: 1;
  /** The browser's whole kept history has been read into the log once. */
  backfilled?: boolean;
  /** day (local, YYYY-MM-DD) -> series key -> chapters first read that day */
  days: Record<string, Record<string, number[]>>;
}

const DAY = 24 * 60 * 60 * 1000;
export const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class ReadingLog {
  data: LogFile = { v: 1, days: {} };
  private seen = new Set<string>();
  private changed = false;

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LogFile;
        if (raw.v === 1 && raw.days) this.data = raw;
      } catch {
        /* a damaged log starts over; the next history read fills it again */
      }
    }
    for (const byKey of Object.values(this.data.days)) {
      for (const [key, chapters] of Object.entries(byKey)) for (const c of chapters) this.seen.add(`${key}#${c}`);
    }
  }

  /** Record a chapter as read at this time. Returns false when it was already counted. */
  add(key: string, chapter: number, at: number): boolean {
    const id = `${key}#${chapter}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    ((this.data.days[dayOf(at)] ??= {})[key] ??= []).push(chapter);
    this.changed = true;
    return true;
  }

  markBackfilled() {
    if (!this.data.backfilled) {
      this.data.backfilled = true;
      this.changed = true;
    }
  }

  /** Move everything logged under one key to another (used when two entries are merged). */
  rename(from: string, to: string) {
    for (const byKey of Object.values(this.data.days)) {
      const moved = byKey[from];
      if (!moved) continue;
      delete byKey[from];
      for (const c of moved) {
        if (this.seen.has(`${to}#${c}`)) continue;
        this.seen.add(`${to}#${c}`);
        (byKey[to] ??= []).push(c);
      }
      this.changed = true;
    }
  }

  save() {
    if (!this.file || !this.changed) return;
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.file + '.tmp', this.file);
    this.changed = false;
  }

  /**
   * Totals per day, week and month, and the series read most in the last 30 days.
   * `resolve` turns a series key into the library series it belongs to; keys it doesn't know
   * (or hides) still count toward the totals but are not named.
   */
  stats(resolve: (key: string) => { id: string; title: string } | undefined, now = Date.now()): ReadingStats {
    const perDay = new Map<string, number>();
    for (const [day, byKey] of Object.entries(this.data.days)) {
      perDay.set(day, Object.values(byKey).reduce((a, c) => a + c.length, 0));
    }
    const logged = [...perDay.keys()].sort();
    const count = (ms: number) => perDay.get(dayOf(ms)) ?? 0;
    // Noon avoids landing on the wrong date when a day is 23 or 25 hours long.
    const noon = new Date(now);
    noon.setHours(12, 0, 0, 0);
    const back = (n: number) => noon.getTime() - n * DAY;
    const sum = (n: number) => Array.from({ length: n }, (_, i) => count(back(i))).reduce((a, b) => a + b, 0);

    const days = Array.from({ length: 30 }, (_, i) => ({ day: dayOf(back(29 - i)), chapters: count(back(29 - i)) }));
    // Weeks start on Monday.
    const sinceMonday = (noon.getDay() + 6) % 7;
    const weeks = Array.from({ length: 12 }, (_, i) => {
      const start = back(sinceMonday + 7 * (11 - i));
      let chapters = 0;
      for (let d = 0; d < 7; d++) chapters += count(start + d * DAY);
      return { start: dayOf(start), chapters };
    });
    const byMonth = new Map<string, number>();
    for (const [day, n] of perDay) byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0) + n);
    const months = [...byMonth].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, chapters]) => ({ month, chapters }));

    // A streak still stands if today has nothing yet.
    let streak = 0;
    for (let i = count(back(0)) ? 0 : 1; count(back(i)); i++) streak++;
    let best: ReadingStats['best'];
    for (const [day, chapters] of perDay) if (!best || chapters > best.chapters) best = { day, chapters };

    const recent = new Set(days.map((d) => d.day));
    const perSeries = new Map<string, { id?: string; title: string; chapters: number }>();
    let unnamed = 0;
    for (const [day, byKey] of Object.entries(this.data.days)) {
      if (!recent.has(day)) continue;
      for (const [key, chapters] of Object.entries(byKey)) {
        const s = resolve(key);
        if (!s) {
          unnamed += chapters.length;
          continue;
        }
        const cur = perSeries.get(s.id) ?? { id: s.id, title: s.title, chapters: 0 };
        cur.chapters += chapters.length;
        perSeries.set(s.id, cur);
      }
    }
    const top = [...perSeries.values()].sort((a, b) => b.chapters - a.chapters).slice(0, 10);

    return {
      since: logged[0],
      today: count(back(0)),
      last7: sum(7),
      last30: sum(30),
      total: [...perDay.values()].reduce((a, b) => a + b, 0),
      activeDays30: days.filter((d) => d.chapters > 0).length,
      seriesRead30: perSeries.size,
      streak,
      best,
      days,
      weeks,
      months,
      top,
      unnamed30: unnamed,
    };
  }
}
