# Connecting AniList

Connecting is optional. With it, the tracker pulls in your AniList manga list and sends your chapter progress back. It takes about two minutes, once.

AniList has no "log in with a password" for small apps. Instead you create a "client" on your own account (a permission slip for this app) and then hand the app a token.

## Steps

1. **Open the Developer page.** Go to <https://anilist.co/settings/developer> and sign in if asked.
   On the site this is: your avatar (top right) → **Settings** → **Developer** in the left-hand list.

2. **Create a client.** Click **Create New Client**.
   - **Name:** anything. "Manga Tracker" is fine.
   - **Redirect URL:** paste exactly `https://anilist.co/api/v2/oauth/pin`
   - Click **Save**.

3. **Find the client ID.** After saving, AniList shows the client with two values:
   - **ID** — a short number such as `12345`. This is the one you need.
   - **Secret** — a long string. Not needed; leave it alone.

4. **Enter the ID in the tracker.** In the tracker open **Settings**, scroll to **AniList**, and type the ID into the **Client ID** box.

5. **Authorize.** Click **Open AniList to authorize**. A new tab opens on anilist.co asking whether "Manga Tracker" may use your account. Click **Authorize**.

6. **Copy the token.** AniList now shows a page with one very long block of letters and numbers (well over a thousand characters). That block is the token.
   Click inside it, press **Ctrl+A** then **Ctrl+C**.

7. **Connect.** Back in the tracker, paste into the box that says "Paste the token AniList shows you" and click **Connect**.
   Settings then shows **Connected as _your name_** and the first sync starts.

## What happens after connecting

- Everything on your AniList manga list is added to the library.
- Series the tracker has seen you reading are added to your AniList list with your chapter number. Bookmark-only series are not sent.
- From then on a chapter change goes to AniList within a second or two, and your list is fetched back once an hour (or when you click **Refresh**).
- Untick **Keep AniList in sync** in Settings to stop both directions without disconnecting.

## If it doesn't work

| What you see | Cause and fix |
|---|---|
| "Invalid token" after clicking Connect | Part of the token was missed. Go back to the AniList tab, click in the block, Ctrl+A, Ctrl+C, and paste again. |
| AniList shows an error instead of the Authorize page | The Client ID is wrong (the Secret was pasted instead of the ID), or the Redirect URL on the client isn't exactly `https://anilist.co/api/v2/oauth/pin`. Edit the client on the Developer page. |
| The Authorize tab shows a token but you closed it | Click **Open AniList to authorize** again; it shows a fresh token. |
| It worked for a year and then stopped | Tokens last one year. Repeat steps 5 to 7. |

## Privacy

The token is stored encrypted on this PC (Windows protects it with your Windows account) in `%APPDATA%\manga-tracker\config.json`. It is sent only to anilist.co. **Disconnect** in Settings deletes it; you can also remove the client on AniList's Developer page to revoke it there.
