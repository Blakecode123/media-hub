# media-hub design

Agreed 2026-11-19. Personal settings (page names, accounts) live only in the
owner's Google Sheet, not in this public repo.

## Goal

One place for the owner's media, sorted into the owner's own pages. Each page
shows only its own items. There is never a mixed feed.

## Build order

1. YouTube pages, player, watched tracking, thumbs and hide.
2. YouTube recommendations for each page (designed in its own session before build).
3. Shows area: film and TV via TMDB (designed in its own session before build).
4. More sources as the owner adds them.

## Architecture

- **Frontend:** static web app on GitHub Pages (`www/`). Plain HTML/JS, no build
  step. Made for the PC browser. Dark thumbnail grid.
- **Backend:** Google Apps Script in the owner's Google account, bound to a data
  Sheet. It runs as the owner, so it reads YouTube subscriptions through the
  YouTube advanced service with no separate OAuth consent screen.
- **Access:** the web app calls the Apps Script web-app URL with a secret key.
  The owner types the key once in Settings; the browser keeps it. The key is
  never in the repo.
- **Deploy:** code goes to Apps Script with clasp.
- **AI:** Gemini (free API key) suggests pages for channels. Only channel names,
  descriptions and video titles are sent.
- **Debug:** `?debug=1` turns on browser logging; a `DEBUG` script property
  turns on Apps Script logging.

## Step 1: YouTube pages

### Pages and channels

- The owner makes pages. A page holds channels.
- One channel can be in several pages.
- A page can hold channels the owner does not subscribe to (added by link).
- An **Other** page shows a feed of every subscribed channel not yet placed.
- New subscriptions show in Other.
- **Sorting:** Gemini suggests pages for each unplaced channel from its name and
  description. The owner confirms or changes each suggestion. A channel stays in
  Other until confirmed.

### Feeds

- Each page shows new uploads from its channels only, newest first.
- Shorts are hidden (uploads-without-Shorts playlist; to verify in the first spike).
- Live-stream recordings show in feeds (Live playlist, checked every 6 h).
- No length filter.
- Feeds hold uploads from the last 30 days only (YouTube API data-storage rule).
- Refresh every hour, plus a refresh button.
- Quota: about 1 unit per channel per hourly refresh, plus 1 per channel every 6 h
  for live recordings. This stays under 8,000 of the 10,000 daily units up to
  about 280 channels. The first spike counts the channels and lowers the rate if needed.

### Player

- Official YouTube embedded player in a large panel. The feed stays beside it.
- No changes to or overlays on the player.
- Playback stops when a video ends (no autoplay).

### Watched, seen, thumbs and hide

- A video leaves the feed when it is watched and goes to a **Watched** page.
- **Watched in the app:** marked automatically at about 80% played, or on thumbs
  up or down.
- **Watched elsewhere:** the YouTube API gives no watch history, so the app cannot
  see it. A **Seen** button removes one video; **Mark page seen** clears a page.
- **Hide** removes a video the owner does not want to watch.
- Thumbs are stored for step-2 recommendations.

## Spike checks (start of step 1)

1. The uploads-without-Shorts playlist works through `playlistItems.list`.
2. The GitHub Pages site can call the Apps Script web app (CORS and redirects).
3. The Apps Script owner authorization does not expire every 7 days.
4. Channel count, to set the refresh rate.

## Checked API facts (2026-11-19)

- YouTube Data API: 10,000 units/day; `playlistItems.list`, `subscriptions.list`,
  `videos.list`, `channels.list` cost 1 unit each. `search.list` has its own
  bucket of 100 calls/day.
- Google OAuth apps in "Testing" status get refresh tokens that expire after 7
  days; `youtube.readonly` is a sensitive scope.
- YouTube API policies: do not change, block or hide the embedded player; refresh
  or delete stored API data within 30 days.
- TMDB: free for non-commercial use; credit TMDB on an About/Credits page;
  where-to-watch data must credit JustWatch.
- Spotify Web API: recommendations, related artists and audio features closed to
  new apps since 2024-11-27. Not used.
- GitHub Pages on a free account needs a public repo.
- Gemini API free tier: Google may use and human-review prompts. Paid tier: not
  used to improve products.
