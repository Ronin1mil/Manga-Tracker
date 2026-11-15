# Manga Tracker

A local-first tracker for the manga you read in Chrome on your phone. It runs as a small Node server on this PC and opens in a Chrome window. Nothing is uploaded except optional AniList sync.

## Run

Double-click `Manga Tracker.cmd`. It builds on first run, opens Chrome on the profile being read, then opens the tracker window at `http://127.0.0.1:47800`. Close the console window to stop it.

From a terminal:

```
npm install
npm run build
npm start
npm test
```

Requires Node 20 or newer.

## Start with Windows

Settings → **Start with Windows** adds a per-user sign-in task (no administrator rights needed; it starts within a second or two of signing in) that runs the server with no window and without opening a browser. Open the tracker from `Manga Tracker.cmd` or `http://127.0.0.1:47800` whenever you want to look at it. Phone reading still only arrives while Chrome on this PC is running and syncing.

What runs by itself, and how often:

| Job | When |
|---|---|
| Look for new reading in the browser | Every 5 minutes, and skipped unless the browser's history or bookmarks file changed |
| Match new series and download covers | Right after new series are found |
| Send your changes to AniList | Immediately, ten changes per request |
| Fetch your AniList list | Once an hour, or on Refresh |
| Released-chapter counts | Each series once a week |
| Recommendations | Once a week |

The process runs at below-normal priority.

## AniList

Step-by-step instructions are in [docs/anilist-setup.md](docs/anilist-setup.md).

## Bookmarks

Browser bookmarks are read when they sit on a tracked site, on a known closed site (mangafarm, the old Asura and Flame Scans addresses and others, listed in `src/shared/sites.ts`), or inside any bookmark folder whose name contains manga, manhwa, manhua, webtoon, comic or novel. A bookmarked chapter becomes the chapter you are on. Series known only from bookmarks go to the Bookmarks tab and are not sent to AniList.

## Reading stats

The Stats button shows chapters per day, week and month. They are counted from the real date of each chapter page you opened, kept in `reading-log.json`; a chapter counts once. Chapters known only as a number (where you already were when a series was first imported, or your AniList list) are never counted, so years of earlier reading can't pile up on the day of the import. Chrome keeps about three months of history, so that is how far back the first chart reaches.

## How reading is detected

Chrome on this PC receives your phone's history and open tabs through Chrome sync. The tracker reads copies of three things in the chosen Chrome profile, and only entries on the sites you list under Tracked sites:

- `History` — pages you opened (proof of reading)
- `Sync Data/LevelDB` — tabs open on your other devices (the freshest signal; needed for sites that change chapter without loading a new page)
- `Bookmarks` — a hint only; these go to the separate Bookmarks tab

Chrome has to be running on this PC for phone data to arrive. A site's own bookmark list (for example mangahub.io/user/bookmarks) can be imported in Settings by copying the page and pasting it in.

## How a detected series gets its details

Sites name series loosely (cut-off titles, missing apostrophes, tags like "(Manhwa)", a different translation). Auto-match cleans the name up (`src/main/titles.ts`), then tries, in order:

1. a series already in the library under any of its names;
2. AniList;
3. MangaDex, which lists many alternative names and often points back at the AniList entry;
4. nothing found: the series is kept under the site's own name, marked "No details", and retried on later runs.

A match is accepted only when a name is the same or very nearly the same and the chapter count is plausible. Each decision is written to `%APPDATA%\manga-tracker\log.txt`.

## The library folder

Everything you'd want in ten years is plain files in the folder you choose:

| File | What it is |
|---|---|
| `library.json` | Every series: titles, metadata, status, chapter, notes, links |
| `history.jsonl` | Append-only log of every progress change |
| `covers/` | Cover and banner images |
| `index.html` | A page showing the whole library; opens in any browser without this app |
| `reading-log.json` | Which chapters were read on which day (for the stats) |
| `recommendations.json` | Saved recommendation candidates |
| `backups/` | The last ten copies of `library.json` |

App settings (chosen library, history source, encrypted AniList token) are in `%APPDATA%\manga-tracker\config.json`.

## Environment variables

| Variable | Effect |
|---|---|
| `MANGA_TRACKER_PORT` | Port to serve on (default 47800) |
| `MANGA_TRACKER_BROWSER=default` | Open in the default browser instead of Chrome |
| `MANGA_TRACKER_NO_OPEN=1` | Don't open a browser |
| `MANGA_TRACKER_USERDATA`, `MANGA_TRACKER_LIBRARY` | Override the settings folder and library folder |

## Layout

- `src/main/server.ts` — HTTP server, sync with AniList, detection pipeline
- `src/main/chapterParser.ts` — turns a page URL into series and chapter (tested in `tests/`)
- `src/main/chromeHistory.ts`, `src/main/syncData.ts` — read Chrome's history, bookmarks and synced device tabs
- `src/main/store.ts`, `src/main/staticPage.ts` — the library folder
- `src/main/readingLog.ts` — per-day reading log and the stats
- `src/main/recommend.ts` — recommendation scoring
- `src/main/mangadex.ts`, `src/main/mangaupdates.ts` — backup sources for details, novels and chapter counts
- `src/shared/sites.ts` — the built-in list of reading sites
- `src/renderer/` — the React interface

## New chapters, duplicates and kinds

- **New chapters:** a card shows "3 new" when chapters are out that you haven't read. Sort by "New chapters to read" to see the series you are closest to caught up on first. Counts for series you are reading are checked daily, the rest weekly.
- **Merging duplicates:** open either entry, press **Merge…** and pick the other one. Their sites, the higher chapter, notes and reading stats are combined; the entry with details from a source is the one kept. Two entries that are different series on AniList are refused.
- **Manga, manhwa, manhua:** the country a series comes from is recorded and shown, and recommendations use it to tell the three apart.

## Other browsers (beta)

Settings → **Other browsers** reads more browser history files on this PC (Edge, Brave, Vivaldi, Opera, Firefox) alongside the main one, which is also how reading in those browsers on a phone arrives. Safari on an iPhone goes through an inbox text file filled by a share-sheet Shortcut. Both are described in [docs/other-browsers.md](docs/other-browsers.md).

Every sort has a direction button next to it, and merging two entries lets you choose whose details, chapter and status to keep.

## Continue reading, closed sites, backup

- **Continue reading**: the Reading tab starts with the series you read most recently that have chapters waiting. A click opens the next chapter where the site's links allow it, otherwise the last page you read.
- **Closed sites**: once a day the tracker checks whether the sites your links point at are still there. A series whose site is gone gets a "Site closed" badge and a **Find another site** button. It looks on the sites you already read on (building the link the way that site does, and checking it where the site allows), then MangaDex, then offers Google searches. Titles are sent to those sites to do this.
- **Backup**: Settings → **Save backup** downloads one file with the library, reading history and stats. **Restore backup…** replaces the library with such a file, here or on another PC; the library from before is kept in `backups/`. The AniList login is not in the file.
