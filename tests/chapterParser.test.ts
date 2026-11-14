import { describe, expect, it } from 'vitest';
import { domainMatches, normalizeDomain, parseChapterUrl } from '../src/main/chapterParser';

const p = (url: string, title?: string, override?: string) => parseChapterUrl(url, title, override);

describe('parseChapterUrl', () => {
  it('slug then chapter segment', () => {
    expect(p('https://www.example.com/manga/one-piece/chapter-1100')).toMatchObject({
      domain: 'example.com', slug: 'one-piece', chapter: 1100, titleGuess: 'One Piece',
    });
  });
  it('slug and chapter in one segment', () => {
    expect(p('https://example.com/one-piece-chapter-1100/')).toMatchObject({ slug: 'one-piece', chapter: 1100 });
  });
  it('decimal chapters with dot and dash', () => {
    expect(p('https://example.com/read/solo-leveling/chapter-45.5')?.chapter).toBe(45.5);
    expect(p('https://example.com/read/solo-leveling/chapter-45-5')?.chapter).toBe(45.5);
  });
  it('chapter as its own path segment', () => {
    expect(p('https://example.com/title/berserk/chapter/12')).toMatchObject({ slug: 'berserk', chapter: 12 });
  });
  it('short forms and leading zeros', () => {
    expect(p('https://example.com/manga/vagabond/ch_007')).toMatchObject({ slug: 'vagabond', chapter: 7 });
    expect(p('https://example.com/manga/vagabond/v01/c045/1.html')).toMatchObject({ chapter: 45 });
  });
  it('ignores page numbers after the chapter', () => {
    expect(p('https://example.com/manga/vinland-saga/chapter-200/3')).toMatchObject({ slug: 'vinland-saga', chapter: 200 });
  });
  it('trailing language suffix', () => {
    expect(p('https://example.com/kingdom/chapter-800-english')).toMatchObject({ slug: 'kingdom', chapter: 800 });
  });
  it('falls back to the page title when the URL has only an id', () => {
    expect(
      p('https://example.org/chapter/0a1b2c3d-1111-2222-3333-444455556666', 'Dandadan - Ch. 150 - Example'),
    ).toMatchObject({ slug: 'dandadan', chapter: 150, titleGuess: 'Dandadan' });
  });
  it('uses the page title for the title guess', () => {
    expect(p('https://example.com/manga/op/chapter-5', 'Read One Piece Chapter 5 Online')?.titleGuess).toBe('One Piece');
  });
  it('does not match words that merely contain "ch"', () => {
    expect(p('https://example.com/watch-123')).toBeNull();
    expect(p('https://example.com/manga/one-piece')).toBeNull();
  });
  it('per-site override', () => {
    expect(
      p('https://example.com/r/12-my-series/88', undefined, '^/r/\\d+-(?<slug>[^/]+)/(?<chapter>[\\d.]+)'),
    ).toMatchObject({ slug: 'my-series', chapter: 88 });
  });
  it('comix.to shape: id-prefixed slug and chapter, bot-wall page title', () => {
    expect(
      p('https://www.comix.to/title/2vvd-gatekeeper-of-the-boundless-world/5611363-chapter-72', 'Attention Required! | Cloudflare'),
    ).toMatchObject({
      domain: 'comix.to', slug: '2vvd-gatekeeper-of-the-boundless-world', chapter: 72,
      titleGuess: 'Gatekeeper Of The Boundless World',
    });
  });
  it('comix.to page title with a dot separator', () => {
    expect(
      p('https://comix.to/title/d8wg-life-of-a-quack-healer/6045332-chapter-50', 'Life of a Quack Healer · Ch.50'),
    ).toMatchObject({ chapter: 50, titleGuess: 'Life of a Quack Healer' });
  });
  it('mangahub.io shape: URL chapter wins over a lagging page title', () => {
    expect(
      p('https://mangahub.io/chapter/dungeon-reset/chapter-56', 'Dungeon Reset 55 - Dungeon Reset Chapter 55 - Dungeon Reset'),
    ).toMatchObject({ domain: 'mangahub.io', slug: 'dungeon-reset', chapter: 56, titleGuess: 'Dungeon Reset' });
    expect(p('https://mangahub.io/chapter/jujutsu-kaisen_102/chapter-146')).toMatchObject({
      slug: 'jujutsu-kaisen-102', chapter: 146, titleGuess: 'Jujutsu Kaisen',
    });
  });
  it('rejects junk', () => {
    expect(p('not a url')).toBeNull();
  });
});

describe('domains', () => {
  it('normalizes', () => {
    expect(normalizeDomain('https://WWW.Example.com/manga/x')).toBe('example.com');
  });
  it('matches subdomains only', () => {
    expect(domainMatches('m.example.com', 'example.com')).toBe(true);
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
  });
});

describe('parseSeriesUrl', () => {
  it('reads a series page link from a site bookmark list', async () => {
    const { parseSeriesUrl } = await import('../src/main/chapterParser');
    expect(parseSeriesUrl('https://mangahub.io/manga/jujutsu-kaisen_102', 'Jujutsu Kaisen')).toMatchObject({
      domain: 'mangahub.io', slug: 'jujutsu-kaisen-102', chapter: 0, titleGuess: 'Jujutsu Kaisen',
    });
    expect(parseSeriesUrl('https://comix.to/title/d8wg-life-of-a-quack-healer', 'Read')).toMatchObject({
      slug: 'd8wg-life-of-a-quack-healer', titleGuess: 'Life Of A Quack Healer',
    });
    expect(parseSeriesUrl('https://mangahub.io/user/bookmarks')).toBeNull();
    expect(parseSeriesUrl('https://mangahub.io/chapter/dungeon-reset/chapter-56')).toBeNull();
  });
});
