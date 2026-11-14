import { describe, expect, it } from 'vitest';
import { bestLink, chapterUrl, fill, hostOf, onDeadSite, searchUrl, siteTemplate, slugFor } from '../src/shared/links';

describe('links', () => {
  it('knows which site a link is on and whether that site is gone', () => {
    expect(hostOf('https://www.Example.com/manga/one/chapter-5')).toBe('example.com');
    expect(hostOf('not a link')).toBeUndefined();
    expect(onDeadSite('https://www.closed.test/manga/one/chapter-5', ['closed.test'])).toBe(true);
    expect(onDeadSite('https://read.closed.test/x', ['closed.test'])).toBe(true);
    expect(onDeadSite('https://notclosed.test/x', ['closed.test'])).toBe(false);
    expect(onDeadSite(undefined, ['closed.test'])).toBe(false);
  });

  it('prefers a link that still works', () => {
    const s = { lastUrl: 'https://closed.test/manga/one/chapter-5', readAt: 'https://example.com/manga/one/chapter-6' };
    expect(bestLink(s, ['closed.test'])).toBe(s.readAt);
    expect(bestLink(s, [])).toBe(s.lastUrl);
    expect(bestLink({ lastUrl: s.lastUrl }, ['closed.test'])).toBe(s.lastUrl);
  });

  it('builds the next chapter link where the site allows it', () => {
    expect(chapterUrl('https://example.com/chapter/some-title/chapter-134', 135)).toBe('https://example.com/chapter/some-title/chapter-135');
    expect(chapterUrl('https://example.com/manga/some-title/chapter/124?page=2#x', 125)).toBe('https://example.com/manga/some-title/chapter/125');
    expect(chapterUrl('https://example.com/manga/some-title/chapter-50-5/', 51)).toBe('https://example.com/manga/some-title/chapter-51/');
    expect(chapterUrl('https://example.com/manga/some-title/chapter_54', 55)).toBe('https://example.com/manga/some-title/chapter_55');
    expect(chapterUrl('https://example.com/some-title-chapter-147/', 148)).toBe('https://example.com/some-title-chapter-148/');
  });

  it('gives up on links that carry a page id', () => {
    expect(chapterUrl('https://example.com/title/some-title/6045978-chapter-58', 59)).toBeUndefined();
    expect(chapterUrl('https://example.com/comics/1234-some-title/chapters/40002960-chapter-60', 61)).toBeUndefined();
    expect(chapterUrl('https://example.com/1672760368-some-title-chapter-50/', 51)).toBeUndefined();
    expect(chapterUrl('https://example.com/manga/some-title/', 2)).toBeUndefined();
    expect(chapterUrl(undefined, 2)).toBeUndefined();
  });

  it('learns how a site builds links from one example', () => {
    const hub = siteTemplate('https://example.com/chapter/some-title/chapter-134', 'some-title')!;
    expect(hub.chapter).toBe('https://example.com/chapter/{slug}/chapter-{ch}');
    expect(hub.series).toBeUndefined();
    expect(fill(hub.chapter!, 'other-title', 7)).toBe('https://example.com/chapter/other-title/chapter-7');

    const plain = siteTemplate('https://www.example.com/manga/some-title/chapter-10/', 'some-title')!;
    expect(plain.chapter).toBe('https://www.example.com/manga/{slug}/chapter-{ch}/');
    expect(plain.series).toBe('https://www.example.com/manga/{slug}/');

    const ids = siteTemplate('https://example.com/title/some-title/6045978-chapter-58', 'some-title')!;
    expect(ids.chapter).toBeUndefined();
    expect(ids.series).toBe('https://example.com/title/{slug}/');

    expect(siteTemplate('https://example.com/some-title-chapter-5/', 'some-title')).toBeUndefined();
  });

  it('names a series the way sites do, and builds searches', () => {
    expect(slugFor("The Hero's Return: Part 2")).toBe('the-heros-return-part-2');
    expect(slugFor('Café & Sword')).toBe('cafe-and-sword');
    expect(searchUrl('Some Title', 12)).toBe('https://www.google.com/search?q=%22Some%20Title%22%20chapter%2012');
    expect(searchUrl('Some Title', 12, 'example.com')).toBe('https://www.google.com/search?q=%22Some%20Title%22%20chapter%2012%20site%3Aexample.com');
  });
});
