# Step 1 build plan: YouTube pages

Rev 2, 2026-11-19: Gemini review findings applied (Codex skipped: usage limit).
Design: [DESIGN.md](DESIGN.md). Single owner, single user.

## 0. Order of work

1. **Gate spikes S1, S2, S4** in the real Apps Script project. Stop and report if one fails.
2. **Backend** (`apps-script/`) and **frontend** (`www/`) in parallel, against the API
   contract in section 3. The frontend uses a mock backend until the real one is ready.
3. **Integration:** frontend on GitHub Pages talks to the real backend; end-to-end checks.
4. **S3** is a check 8 days after go-live, not a gate.

Owner steps before S1: turn on the Apps Script API; `clasp login` (personal Gmail).

## 1. Spikes

| # | Question | Test | Fallback if it fails |
|---|---|---|---|
| S1 | Do the `UULF` (videos, no Shorts) and `UULV` (live recordings) playlists work in `playlistItems.list`? Which channels return 404? | Call `UULF`, `UULV` and `UU` for 10 channels (some with Shorts, some that stream); compare. | Per channel: `UULF` 404 → use `UU` and drop Shorts by a no-redirect `GET https://www.youtube.com/shorts/<id>` (200 = Short) for new videos of 180 s or less. `UrlFetchApp` has no `HEAD`. |
| S2 | Can a GitHub Pages origin call the Apps Script web app? | `fetch(execUrl, {method:'POST', headers:{'Content-Type':'text/plain'}, body})` from localhost and from the Pages URL; read JSON; also a forced server error. | JSONP via GET (`callback=`) for reads; form POST for writes. |
| S4 | How many channels, and how many quota units per day? | First refreshes write channel count and units to the run log. | Raise `REFRESH_MINUTES` so daily units stay under about 8,000. |
| S3 | Does the owner's authorization keep working (no 7-day expiry)? | Check the run log 8 days after go-live. Expected to pass: default Apps Script projects are not "Testing" OAuth apps. | Link the script to a standard GCP project set to "In production". |

## 2. Backend (`apps-script/`, pushed with clasp)

Container-bound to a new Sheet "media-hub data" (`clasp create --type sheets`).
`.clasp.json` is git-ignored. Files are plain JS (`.js`, pushed as `.gs`).

| File | Role |
|---|---|
| `appsscript.json` | Time zone Australia/Sydney, V8. Web app `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. `dependencies.enabledAdvancedServices`: YouTube v3 (this turns the API on in the default GCP project; calls still go through `UrlFetchApp`). Scopes: `youtube.readonly`, `spreadsheets.currentonly`, `script.external_request`, `script.scriptapp`. |
| `Config.js` | Script Properties: `KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `DEBUG`, `REFRESH_MINUTES` (default 60), `LIVE_HOURS` (default 6). `dlog()` writes only when `DEBUG` is on. |
| `Logic.js` | Pure functions, no Apps Script calls (tested in Node): channel-link parsing, playlist IDs, ISO 8601 duration to seconds, 30-day window and purge rules, Other rule, merge rules, key check, Gemini response check. |
| `Store.js` | Sheet tables (2.1): read all rows to objects, merge-write by ID, delete by filter. |
| `YouTube.js` | REST calls with `ScriptApp.getOAuthToken()` through `UrlFetchApp.fetchAll` (batches of 50), `muteHttpExceptions: true` on every request, status handled per response, retry with backoff on 403 rate / 5xx, quota counter per run. |
| `Refresh.js` | The timer job (2.2). |
| `Gemini.js` | Page suggestions (2.3). |
| `Api.js` | `doPost`: whole body in `try/catch`, always JSON out (an uncaught error gives an HTML page without CORS headers). Strict key check: stored `KEY` is a string of 32+ chars and equals `req.key`; else `auth`. Mutating actions take the script lock (2.4). |
| `Setup.js` | One-time `setup()`: make tabs (plain-text format), make `KEY` from two `Utilities.getUuid()` values without dashes (never overwrite an existing `KEY`; show it once), install one timer trigger `everyMinutes(15)`. |

### 2.1 Sheet tables

| Tab | Columns |
|---|---|
| `pages` | id, name, hint (optional text for AI sorting), order |
| `channels` | id, title, description (first 300 chars), thumb, subscribed, addedByLink, pageIds (comma list), suggestedPageIds (comma list, or `none` = AI found no page), playlist (`LF` or `UU`), hasLive (`yes` / `no` / `unknown`), liveChecked, metaUpdated |
| `videos` | id, channelId, title, published, durationSec, fetched |
| `state` | videoId, channelId, state (watched / seen / hidden), rating (up / down), updated |
| `runs` | time, kind, channels, units, newVideos, errors, ms |

Rules:
- All tabs use plain-text format, and text fields (titles, descriptions, dates) are stored
  JSON-encoded, so Sheets never turns `=...`, `+...`, `-...`, dates or comma lists into formulas, dates or numbers.
- Thumbnails are not stored: the frontend builds `https://i.ytimg.com/vi/<id>/mqdefault.jpg`.
- `videos` keeps uploads published in the last 30 days only (API storage rule).
- When a video leaves `videos`: its `state` row is deleted unless it has a rating; a rated row keeps
  only videoId, channelId, rating (IDs and the owner's own ratings, no API text) for step 2.
- Channel title, description and thumb are refreshed at least every 7 days.

### 2.2 Refresh job (timer tick every 15 min)

1. Exit at once unless due: `now - lastRefresh >= REFRESH_MINUTES - 2 min`, or a "refresh now" request is waiting.
   A `refreshRunning` Script Property (stale after 6 min) stops overlapping runs.
2. **Fetch (no lock held):**
   - Subscriptions: `subscriptions.list mine=true`, 50 per page.
   - Uploads: per channel (subscribed or added by link), `playlistItems.list maxResults=10` on `UULF`;
     on 404 set `playlist=UU` and use `UU` from then on.
   - Live recordings: every `LIVE_HOURS`, `UULV` for channels with `hasLive` `yes` or `unknown`;
     404 → `hasLive=no` (checked again after 7 days).
   - New video IDs inside the 30-day window: `videos.list part=contentDetails,snippet,liveStreamingDetails`
     in batches of 50. Skip upcoming premieres and running lives until they finish.
   - Shorts check (only for `UU` channels, new videos of 180 s or less), as in S1.
   - Channel metadata older than 7 days: `channels.list`, batches of 50.
3. **Write (script lock, short):** re-read the tabs, merge the fetched data, write back.
   The job never changes owner fields (`pageIds`, `state`, `rating`). New subscriptions get no pages (Other).
   Gone subscriptions: `subscribed=false`; delete the channel and its videos only if it is in no page and not added by link.
   Purge by the rules in 2.1.
4. **Gemini (no lock held), then a short lock to write suggestions** (2.3).
5. Write a `runs` row; store `lastRefresh` and `lastError`; clear `refreshRunning`.

Cost per day at about 200 channels: uploads hourly about 4,800 units, live recordings every 6 h
about 800, plus a few units for subscriptions, new videos and metadata. Hourly refresh fits under
8,000 units a day up to about 280 channels; S4 sets the rate.

### 2.3 Gemini page suggestions

- Runs only if at least one page exists and a Gemini key is set.
- Automatic runs: channels with no pages and an empty `suggestedPageIds`. The Sort screen's
  "Suggest with AI" can re-run any channel, `none` included.
- Input: pages (id, name, hint) and up to 50 channels (id, title, description up to 300 chars,
  up to 5 recent video titles).
- Output: JSON schema `[{channelId, pageIds[]}]` (`responseMimeType: application/json`).
- Check: drop unknown page IDs and channel IDs. Empty list → `suggestedPageIds = none`.
- The owner confirms or edits in the Sort screen. Nothing moves without a click.
- Model name comes from `GEMINI_MODEL` (check the current free Flash model at build time).
- On 429: back off; retry on a later run; never block the refresh.

### 2.4 Concurrency

- All mutating API actions take `LockService.getScriptLock()` (wait up to 10 s, else `busy`; the frontend retries).
- The refresh job holds the lock only for its write phases (2.2 steps 3 and 4), never during network calls.

## 3. API contract

All calls are `POST <execUrl>` with `Content-Type: text/plain` (no CORS preflight) and a
JSON body `{key, action, ...}`. Reply: `{ok: true, ...}` or `{ok: false, error}`. A wrong or
missing key gets `{ok:false, error:'auth'}` and nothing else.

| action | Body | Reply |
|---|---|---|
| `bootstrap` | none | `pages`, `channels`, `videos` (with `state` and `rating` merged in), `lastRefresh`, `lastError` |
| `setState` | items: `[{videoId, channelId}]`, state (watched / seen / hidden / null) | count. One call covers Seen, Hide, Mark page seen (the client sends the page's video list, so Other works the same) and their undo. |
| `rate` | videoId, channelId, rating (up / down / null) | ok (also sets watched) |
| `savePages` | full pages list | pages. Deleted page IDs are removed from every channel's `pageIds` and `suggestedPageIds`. |
| `setChannelPages` | channelId, pageIds | channel |
| `addChannel` | link (`@handle`, channel URL, or video URL) | `{channel, videos}`: resolved with `channels.list forHandle` / `id`, or `videos.list`; its uploads are fetched at once (about 2 units). |
| `removeChannel` | channelId (only if not subscribed) | ok |
| `suggestPages` | channelIds (optional) | channels with suggestions |
| `refreshNow` | none | the `bootstrap` reply after the run, or `busy` (at most one run per 5 min) |

Other rule (in `Logic.js` and `logic.js`): a subscribed channel is in Other when none of its `pageIds` matches an existing page.

## 4. Frontend (`www/`, GitHub Pages)

Plain HTML/JS modules, no build step, dark theme, 1920x1080 first.

| File | Role |
|---|---|
| `index.html` | Shell: sidebar, main area, player panel. |
| `style.css` | Dark thumbnail grid; player split view. |
| `api.js` | Backend client and outbox (below); `?mock=1` uses `mock/bootstrap.json` and keeps changes in memory. |
| `logic.js` | Pure functions (tested in Node): feed per page, Other, Watched, counts, applying pending actions on top of a `bootstrap` reply. |
| `player.js` | YouTube IFrame Player API. Polls time every 5 s while playing; marks watched when `duration > 0` and `time / duration >= 0.8`, or on ENDED. |
| `app.js` | State, render, actions, Settings and Sort screens. |
| `mock/bootstrap.json` | Fake channels and videos (no real data). |

Screens:
- **Sidebar:** pages in order with unwatched counts, then Other, Watched, Sort, Settings.
- **Page feed:** grid of cards, newest first. Card: thumbnail, duration, title, channel, age, a "live" tag for
  live recordings; buttons Seen and Hide. Header: page name, Mark page seen, Refresh, last refresh time.
  A banner shows `lastError`.
- **Player panel:** opens beside the feed (player about 60% of the width). Thumbs up/down under it.
  No overlays on the player. Stops at the end. A video marked watched leaves the feed when the panel
  closes or another video starts, not mid-play.
- **Undo:** Seen, Hide and Mark page seen show a 5 s undo toast.
- **Sort:** channel list with page chips; AI-suggested chips shown dashed with one-click accept;
  filter "unsorted only"; "Suggest with AI" button; add channel by link.
- **Settings:** backend URL and key (kept in `localStorage`), pages (add, rename, reorder,
  delete, hint text), Credits.

Behaviour:
- **Outbox:** every action updates the screen first and goes into an outbox kept in `localStorage`.
  Undoable actions wait in the outbox until their toast closes (an undo just removes them); they are sent
  at once on `pagehide` / `visibilitychange`. Failed sends stay in the outbox and retry.
- **Load:** show the cached `bootstrap` at once; send the outbox; then fetch `bootstrap` and apply any
  actions still pending on top of it before render and cache.
- `?debug=1` logs API calls, timings and player events to the console.
- Referrer policy stays default (`strict-origin-when-cross-origin`); the YouTube embed needs it.

## 5. Other files

- `.github/workflows/pages.yml`: deploy `www/` on push to `main` (from Mix Pairs, without the service-worker stamp).
- `tests/*.test.mjs`: `node --test`; loads `apps-script/Logic.js` in a `vm` context and imports `www/logic.js`.
- `.claspignore`: push only `apps-script/*.js` and `appsscript.json`.
- `C:\.claude\launch.json`: add `media-hub` (Python `http.server` on port 8767, serving `www/`).

## 6. Done means

- `node --test` passes: link parsing, playlist IDs, ISO 8601 durations, 30-day purge (unrated rows dropped,
  rated rows kept as IDs), Other rule with a deleted page, merge never overwrites owner fields, key check
  (missing, short, wrong), Gemini output check and `none` sentinel, outbox apply on top of `bootstrap`.
- Mock mode in the preview: every screen works; play, seek past 80%, close: the video moves to Watched;
  Seen, Hide, undo and Mark page seen (also on Other) work; Sort accepts a suggestion.
- Real mode: a full refresh has no errors; the `runs` tab shows channel count and units; the Pages site
  loads real data; a wrong key gets `auth`; a server error still returns JSON; a title starting with `=` shows correctly.
- After 24 h: refreshes on time, units per day under 8,000. After 8 days: runs still succeed (S3).

## 7. Assumptions (not covered in the grill)

1. A channel you unsubscribe from on YouTube stays in its pages, marked "not subscribed". It is removed only if it is in no page.
2. Upcoming premieres and running lives are left out until they finish.
3. Seen, Hide and Mark page seen have a 5 s undo.
4. Each page has an optional hint text to help the AI sort.
5. A watched video leaves the feed when the player closes, not during playback.

Decided after review: live-stream recordings show in feeds, checked every 6 h (`LIVE_HOURS`).

## 8. Sessions

- Session A: spikes S1, S2, S4, then backend. Needs the owner's `clasp login` first.
- Session B: frontend in mock mode, tests, Pages workflow. Can start now.
- Main chat: decisions; integration check when both finish; S3 check after 8 days.
- Both sessions work in `D:\Projects\Code\media-hub`, touch only their own folders, and commit only their own files.
