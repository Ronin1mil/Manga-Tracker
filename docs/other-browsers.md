# Reading in browsers other than Chrome (beta)

The tracker learns what you read from browser history files on this PC. Chrome is the main one. This page covers everything else.

## Which browser on the phone works how

| Phone browser | How it reaches the tracker | What you set up |
|---|---|---|
| Chrome | History and open tabs sync to Chrome on this PC | Nothing more: this is the normal setup |
| Edge | History syncs to Edge on this PC | Sign in to Edge on both, turn on History in Edge's sync settings, then tick Edge under Settings → Other browsers |
| Brave | History syncs to Brave on this PC through a sync chain | Join both devices to one sync chain with History switched on, then tick Brave |
| Firefox | History syncs to Firefox on this PC | Sign in to a Firefox account on both, then tick Firefox |
| Safari | Not readable from Windows | Use the inbox file below |
| Anything else | — | Use the inbox file below |

Synced history only lands on this PC while that browser is running here, the same as with Chrome.

Limits of the extra browsers:

- Only history and bookmarks are read. Open tabs on other devices are read for Chrome only.
- Firefox bookmarks are not read yet.
- Firefox keeps the newest few minutes of history in a side file the tracker can't read, so a chapter can take a few minutes to show up.

## Safari: the inbox file

Apple does not sync Safari history to Windows, so the tracker can't see it. The way around is a text file:

1. A Shortcut on the phone adds the page you are on to a text file in iCloud Drive.
2. iCloud for Windows copies that file to this PC.
3. The tracker reads new lines from it on its normal five-minute check.

It is one tap per chapter (Share → the Shortcut) rather than automatic. Tapping it on the last chapter you read in a sitting is enough, because the tracker only needs your highest chapter.

### On the PC

1. Install **iCloud for Windows** from the Microsoft Store and sign in with your Apple account.
2. Turn on **iCloud Drive**.
3. In File Explorer, open **iCloud Drive → Shortcuts**. The file will appear here after the first use on the phone.

### On the iPhone

1. Open the **Shortcuts** app and tap **+** to make a new shortcut.
2. Tap the name at the top, choose **Rename**, and call it `Track manga`.
3. Tap the **ⓘ** button at the bottom and switch on **Show in Share Sheet**. Under "Share Sheet Types" leave only **Safari web pages** and **URLs** ticked.
4. Add the action **Get Details of Safari Web Page**, and set it to get **Name** from **Shortcut Input**.
5. Add the action **Text**. In the text box put, in this order: the variable **Shortcut Input**, a tab character, then the variable **Details of Safari Web Page**.
   - The keyboard has no tab key. If you can't paste one, type ` | ` (space, bar, space) instead; the tracker then reads the title from the page address alone, which is usually enough.
6. Add the action **Append to Text File**. Set the folder to **Shortcuts**, the file path to `manga-inbox.txt`, and leave "Make New Line" on.
7. Tap **Done**.

To use it: on a chapter page in Safari tap **Share**, then **Track manga**. The first time, iOS asks for permission to save to the file; choose **Always Allow**.

### Back on the PC

1. After using the shortcut once, check that `manga-inbox.txt` has appeared in **iCloud Drive → Shortcuts**.
2. Right-click the file, choose **Copy as path**.
3. In the tracker open **Settings**, paste the path into **Inbox file**, and press **Save**.

The site must be in your tracked sites, or use the usual chapter-style address (`…/chapter-12`), for the link to be recognised.

### What the file may contain

One page per line. Any of these work:

```
https://example.com/manga/some-title/chapter-12
https://example.com/manga/some-title/chapter-12<TAB>Some Title Chapter 12
2026-11-14T21:30:00<TAB>https://example.com/manga/some-title/chapter-12<TAB>Some Title Chapter 12
```

A line with no date counts as read at the moment the tracker first sees it. Anything can write to this file, so the same route works for other apps and other devices (a synced folder from Dropbox or OneDrive works just as well as iCloud).

## Not tested

Firefox reading was tested with a built history file, not a real Firefox. A second Chromium browser was read without errors. The inbox file was tested by writing lines to it on the PC; the phone Shortcut steps were written from Apple's documentation and have not been run on a real iPhone. If a step doesn't match what your phone shows, the three actions that matter are: receive the page from the share sheet, build one line of text with the address, append it to a file in iCloud Drive.
