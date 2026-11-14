import { describe, expect, it } from 'vitest';
import { parseChapterUrl } from '../src/main/chapterParser';
import { chaptersInStatus } from '../src/main/mangaupdates';
import { isNovelSite, knownSite } from '../src/shared/sites';
import { maxChapters, percentRead } from '../src/shared/types';

const parse = (url: string, title?: string) => {
  const p = parseChapterUrl(url, title, knownSite(new URL(url).hostname)?.pattern);
  return p && [p.slug, p.chapter];
};

describe('known reading sites', () => {
  it.each([
    ['https://mangahub.io/chapter/nano-machine/chapter-212', ['nano-machine', 212]],
    ['https://www.mangakakalot.gg/manga/solo-leveling/chapter-45', ['solo-leveling', 45]],
    ['https://www.natomanga.com/manga/the-beginning-after-the-end/chapter-12-5', ['the-beginning-after-the-end', 12.5]],
    ['https://mangafire.to/read/one-piece.dkw/en/chapter-1100', ['one-piece', 1100]],
    ['https://asuracomic.net/series/nano-machine-5b3f2a1c/chapter/212', ['nano-machine', 212]],
    ['https://reaperscans.com/series/overgeared/chapter-250', ['overgeared', 250]],
    ['https://mangabuddy.com/the-greatest-estate-developer/chapter-150', ['the-greatest-estate-developer', 150]],
    ['https://mangapill.com/chapters/2-11000000/one-piece-chapter-1100', ['one-piece', 1100]],
    ['https://fanfox.net/manga/tower_of_god/c012/1.html', ['tower-of-god', 12]],
    ['https://novelbin.com/b/shadow-slave/chapter-1200', ['shadow-slave', 1200]],
    ['https://novelfull.com/reverend-insanity/chapter-33-the-beginning.html', ['reverend-insanity', 33]],
    ['https://freewebnovel.com/novel/lord-of-the-mysteries/chapter-7', ['lord-of-the-mysteries', 7]],
    ['https://novelfire.net/book/shadow-slave/chapter-88', ['shadow-slave', 88]],
    ['https://www.wuxiaworld.com/novel/martial-god-asura/mga-chapter-300', ['martial-god-asura', 300]],
  ])('%s', (url, want) => expect(parse(url)).toEqual(want));

  it('reads the chapter from the page title when the link only has a page id', () => {
    expect(parse('https://www.royalroad.com/fiction/21220/mother-of-learning/chapter/301778/1-good-morning-brother', 'Chapter 1 - Mother of Learning | Royal Road'))
      .toEqual(['mother-of-learning', 1]);
  });

  it('knows which sites host novels', () => {
    expect(isNovelSite('www.royalroad.com')).toBe(true);
    expect(isNovelSite('mangahub.io')).toBe(false);
    expect(isNovelSite('example.com')).toBe(false);
  });
});

describe('chapter totals', () => {
  it('reads a count out of the MangaUpdates status text', () => {
    expect(chaptersInStatus('270 WN Chapters (243 + 27 SS Chapters; Complete)\n14 Volumes')).toBe(270);
    expect(chaptersInStatus('200 Chapters + Prologue (Complete)')).toBe(200);
    expect(chaptersInStatus('15 Volumes (Ongoing)')).toBeUndefined();
  });
  it('gives the max and the percent, never above 100', () => {
    expect(maxChapters({ totalChapters: 200, latestChapter: 150, progress: 50 })).toBe(200);
    expect(percentRead({ latestChapter: 180, progress: 45 })).toBe(25);
    expect(percentRead({ latestChapter: 100, progress: 104 })).toBe(100);
    expect(percentRead({ progress: 10 })).toBeUndefined();
  });
});
