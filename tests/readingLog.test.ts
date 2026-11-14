import { describe, expect, it } from 'vitest';
import { ReadingLog, dayOf } from '../src/main/readingLog';
import { parseChapterUrl } from '../src/main/chapterParser';
import { kindLabel, unreadChapters } from '../src/shared/types';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime(); // Sat 14 Nov 2026, local time

describe('ReadingLog', () => {
  it('counts a chapter once, on the first day it was seen', () => {
    const log = new ReadingLog();
    expect(log.add('site/a', 5, NOW - 3 * DAY)).toBe(true);
    expect(log.add('site/a', 5, NOW)).toBe(false); // reopened later
    expect(log.add('site/a', 6, NOW)).toBe(true);
    const st = log.stats(() => undefined, NOW);
    expect(st.total).toBe(2);
    expect(st.today).toBe(1);
    expect(st.last7).toBe(2);
    expect(st.days.at(-1)).toEqual({ day: dayOf(NOW), chapters: 1 });
    expect(st.days).toHaveLength(30);
    expect(st.weeks).toHaveLength(12);
  });

  it('names the most-read series and keeps unknown ones out of the list', () => {
    const log = new ReadingLog();
    for (let c = 1; c <= 4; c++) log.add('site/a', c, NOW - DAY);
    for (let c = 1; c <= 2; c++) log.add('other/a', c, NOW - 2 * DAY); // same series on another site
    log.add('site/b', 1, NOW);
    log.add('site/hidden', 1, NOW);
    log.add('site/old', 1, NOW - 60 * DAY); // outside the 30-day window
    const names: Record<string, { id: string; title: string }> = {
      'site/a': { id: 'A', title: 'Alpha' }, 'other/a': { id: 'A', title: 'Alpha' }, 'site/b': { id: 'B', title: 'Beta' },
    };
    const st = log.stats((k) => names[k], NOW);
    expect(st.top).toEqual([{ id: 'A', title: 'Alpha', chapters: 6 }, { id: 'B', title: 'Beta', chapters: 1 }]);
    expect(st.unnamed30).toBe(1);
    expect(st.last30).toBe(8);
    expect(st.total).toBe(9);
    expect(st.best).toEqual({ day: dayOf(NOW - DAY), chapters: 4 });
  });

  it('keeps a streak alive until a full day is missed', () => {
    const log = new ReadingLog();
    log.add('s/a', 1, NOW - DAY);
    log.add('s/a', 2, NOW - 2 * DAY);
    log.add('s/a', 3, NOW - 4 * DAY);
    expect(log.stats(() => undefined, NOW).streak).toBe(2); // nothing today yet, yesterday and the day before count
    log.add('s/a', 4, NOW);
    expect(log.stats(() => undefined, NOW).streak).toBe(3);
  });
});

describe('old bookmark links', () => {
  it('drops the page id that changes every chapter', () => {
    const a = parseChapterUrl('https://www.asurascans.com/1672760368-talent-swallowing-magician-chapter-50-5/', 'Talent-Swallowing Magician Chapter 50.5 - Asura Scans');
    const b = parseChapterUrl('https://asuratoon.com/5709081497-talent-swallowing-magician-chapter-92/', 'Talent-Swallowing Magician chapter 92 – Asura Scans');
    expect(a).toMatchObject({ slug: 'talent-swallowing-magician', chapter: 50.5, titleGuess: 'Talent-Swallowing Magician' });
    expect(b).toMatchObject({ slug: 'talent-swallowing-magician', chapter: 92 });
  });
  it('drops a site id tail from the name and ignores page images', () => {
    expect(parseChapterUrl('https://mangafarm.com/manga/unordinary-n5-abs36IU/chapter/198', 'Unordinary Chapter 198')).toMatchObject({ slug: 'unordinary', chapter: 198 });
    expect(parseChapterUrl('https://mangafarm.com/manga/mashle-abs3yLi/chapter/35')).toMatchObject({ slug: 'mashle', titleGuess: 'Mashle' });
    expect(parseChapterUrl('https://s18.example.com/mangakakalot/h1/hn922359/chapter_4/5.jpg')).toBeNull();
  });
  it('reads the usual /manga/<name>/chapter/<n> shape', () => {
    expect(parseChapterUrl('https://mangafarm.com/manga/return-of-immortal-emperor/chapter/163', 'Return Of Immortal Emperor Chapter 163'))
      .toMatchObject({ domain: 'mangafarm.com', slug: 'return-of-immortal-emperor', chapter: 163 });
  });
});

describe('merging and unread counts', () => {
  it('moves a merged entry\u2019s reading to the entry that is kept, without double counting', () => {
    const log = new ReadingLog();
    log.add('id:a', 1, NOW - DAY);
    log.add('id:a', 2, NOW);
    log.add('id:b', 2, NOW - DAY);
    log.add('id:b', 3, NOW);
    log.rename('id:b', 'id:a');
    const st = log.stats((k) => (k === 'id:a' ? { id: 'a', title: 'A' } : undefined), NOW);
    expect(st.top).toEqual([{ id: 'a', title: 'A', chapters: 3 }]);
    expect(st.unnamed30).toBe(0);
    expect(log.add('id:a', 3, NOW)).toBe(false);
  });
  it('counts chapters that are out and unread', () => {
    expect(unreadChapters({ progress: 97.5, latestChapter: 100 })).toBe(3);
    expect(unreadChapters({ progress: 120, totalChapters: 110 })).toBe(0);
    expect(unreadChapters({ progress: 5 })).toBeUndefined();
  });
  it('names the kind of series from its country', () => {
    expect(kindLabel({ format: 'MANGA', country: 'KR' })).toBe('Manhwa');
    expect(kindLabel({ format: 'MANGA', country: 'CN' })).toBe('Manhua');
    expect(kindLabel({ format: 'MANGA', country: 'JP' })).toBe('Manga');
    expect(kindLabel({ format: 'NOVEL', country: 'KR' })).toBe('Korean novel');
    expect(kindLabel({ format: 'MANHWA' })).toBe('Manhwa');
  });
});
