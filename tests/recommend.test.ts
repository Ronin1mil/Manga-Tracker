import { describe, expect, it } from 'vitest';
import { rank, weight, type RecFile } from '../src/main/recommend';
import type { Series } from '../src/shared/types';

const NOW = 1_800_000_000_000;
const series = (id: number, extra: Partial<Series> = {}): Series => ({
  id: `s${id}`, anilistId: id, titles: { english: `Series ${id}` }, status: 'CURRENT', progress: 100,
  addedAt: 0, updatedAt: 0, genres: ['Action'], ...extra,
});
const cand = (id: number, links: [number, number][], extra = {}) => ({
  meta: { anilistId: id, titles: { english: `Rec ${id}` }, genres: ['Action'], ...extra },
  links: links.map(([from, rating]) => ({ from, rating })),
});
const file = (...candidates: ReturnType<typeof cand>[]): RecFile => ({ fetchedAt: NOW, sources: [], candidates });

describe('weight', () => {
  const DAY = 86_400_000;
  it('lets a thumb override everything', () => {
    expect(weight(series(1, { liked: 1, status: 'DROPPED' }), NOW)).toBe(2);
    expect(weight(series(1, { liked: -1, progress: 500 }), NOW)).toBe(-2);
  });
  it('reads taste from how far you got and whether you are caught up', () => {
    expect(weight(series(1, { status: 'DROPPED' }), NOW)).toBe(-1);
    expect(weight(series(1, { status: 'PLANNING' }), NOW)).toBe(0.25);
    expect(weight(series(1, { origin: 'bookmark', progress: 0 }), NOW)).toBe(0.25);
    expect(weight(series(1, { progress: 20 }), NOW)).toBe(0.5); // no total known: volume only
    expect(weight(series(1, { progress: 20, latestChapter: 200 }), NOW)).toBeCloseTo(0.3); // a tenth of the way in
    expect(weight(series(1, { progress: 195, latestChapter: 200 }), NOW)).toBeCloseTo(1.2); // caught up
    expect(weight(series(1, { progress: 195, latestChapter: 200, lastReadAt: NOW - DAY }), NOW)).toBeCloseTo(1.5); // and reading it now
  });
  it('treats series you quietly stopped as a negative or weak signal', () => {
    expect(weight(series(1, { progress: 12, latestChapter: 200, lastReadAt: NOW - 300 * DAY }), NOW)).toBe(-0.5); // gave up early
    const late = weight(series(1, { progress: 150, latestChapter: 400, lastReadAt: NOW - 300 * DAY }), NOW);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(0.4); // wore thin late: still mildly positive
    expect(weight(series(1, { progress: 2, lastReadAt: NOW - 90 * DAY }), NOW)).toBe(-0.25); // sampled and left
  });
  it('lets a score lead when you gave one', () => {
    expect(weight(series(1, { score: 10, progress: 40 }), NOW)).toBeCloseTo(0.7 * 2 + 0.3 * 1);
    expect(weight(series(1, { score: 2, progress: 40 }), NOW)).toBeLessThan(0);
  });
});

describe('rank', () => {
  it('orders by taste and explains why', () => {
    const lib = [series(1, { liked: 1 }), series(2, { progress: 3 })];
    const out = rank(lib, file(cand(10, [[2, 50]]), cand(11, [[1, 50]])), [], false, NOW);
    expect(out.map((r) => r.meta.anilistId)).toEqual([11, 10]);
    expect(out[0].because).toEqual(['Series 1']);
  });
  it('leaves out library series, dismissed ones and adult ones', () => {
    const lib = [series(1), series(2)];
    const f = file(cand(2, [[1, 9]]), cand(10, [[1, 9]]), cand(11, [[1, 9]], { adult: true }), cand(12, [[1, 9]]));
    expect(rank(lib, f, [12], false, NOW).map((r) => r.meta.anilistId)).toEqual([10]);
    expect(rank(lib, f, [12], true, NOW).map((r) => r.meta.anilistId)).toEqual([10, 11]);
  });
  it('prefers your kind of series and well-rated ones when the links are equal', () => {
    const lib = [series(1, { format: 'MANHWA' }), series(2, { format: 'MANHWA' })];
    const f = file(cand(10, [[1, 9]], { format: 'MANGA' }), cand(11, [[1, 9]], { format: 'MANHWA' }), cand(12, [[1, 9]], { format: 'MANHWA', communityScore: 88 }));
    expect(rank(lib, f, [], false, NOW).map((r) => r.meta.anilistId)).toEqual([12, 11, 10]);
  });
  it('never promotes something reached only through a series you dislike', () => {
    const lib = [series(1, { liked: -1 }), series(2)];
    const out = rank(lib, file(cand(10, [[1, 500]]), cand(11, [[1, 500], [2, 2]])), [], false, NOW);
    expect(out.map((r) => r.meta.anilistId)).toEqual([]);
  });
});
