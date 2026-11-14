import { displayTitle, maxChapters, percentRead, STATUS_LABEL, type Library } from '../shared/types';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A self-contained page so the library can be browsed with no app installed. */
export function renderStaticPage(full: Library): string {
  // NSFW series follow the same switch as the app: left out of the page unless it is turned on.
  const lib = full.settings.showNsfw ? full : { ...full, series: full.series.filter((s) => !s.adult) };
  const groups = new Map<string, typeof lib.series>();
  for (const s of [...lib.series].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const k = s.origin === 'bookmark' ? 'BOOKMARK' : s.status;
    const g = groups.get(k) ?? [];
    g.push(s);
    groups.set(k, g);
  }
  const order = ['CURRENT', 'REPEATING', 'PLANNING', 'PAUSED', 'COMPLETED', 'DROPPED', 'BOOKMARK'] as const;
  const sections = order
    .filter((k) => groups.has(k))
    .map((k) => {
      const cards = groups.get(k)!.map((s) => {
        const img = s.cover
          ? `<img loading="lazy" src="covers/${encodeURIComponent(s.cover)}" alt="">`
          : '<div class="ph"></div>';
        const total = maxChapters(s) ? ` / ${maxChapters(s)} · ${percentRead(s)}%` : '';
        const link = s.readAt || s.anilistUrl;
        const title = esc(displayTitle(s));
        return `<div class="card">${img}<div class="t">${link ? `<a href="${esc(link)}">${title}</a>` : title}</div><div class="c">Ch. ${s.progress}${total}</div></div>`;
      });
      return `<h2>${k === 'BOOKMARK' ? 'Bookmarks (not yet seen reading)' : STATUS_LABEL[k]} (${cards.length})</h2><div class="grid">${cards.join('')}</div>`;
    });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manga Library</title>
<style>
body{font-family:system-ui,sans-serif;background:#14161a;color:#e6e8eb;margin:0;padding:16px 24px}
h1{font-size:20px}h2{font-size:15px;color:#9aa3ad;margin:24px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px}
.card img,.ph{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:6px;background:#262a31;display:block}
.t{font-size:13px;margin-top:6px;line-height:1.25}.c{font-size:12px;color:#9aa3ad}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
small{color:#9aa3ad}
</style></head><body>
<h1>Manga Library <small>${lib.series.length} series · saved ${new Date().toISOString().slice(0, 10)}</small></h1>
${sections.join('\n')}
</body></html>
`;
}
