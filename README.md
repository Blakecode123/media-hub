# media-hub

A personal media hub for the PC browser. It puts YouTube channels into
user-defined pages, so each page shows only its own new uploads and never
a mixed feed. A separate Shows area (film and TV, via TMDB) comes later.

Status: design agreed, build not started. See [docs/DESIGN.md](docs/DESIGN.md).

## Parts

- `www/` (planned): static web app on GitHub Pages. Plain HTML/JS, no build step.
- `apps-script/` (planned): Google Apps Script backend. It reads YouTube
  subscriptions as the owner, refreshes feeds on a timer and stores data in a
  Google Sheet in the owner's account.

This repo holds code only. It holds no personal data, API keys or secrets.

## Setup (owner, one time)

1. Turn on "Google Apps Script API" at https://script.google.com/home/usersettings.
2. Install clasp: `npm install -g @google/clasp`, then run `clasp login`.
3. Further steps come with the step-1 build.

## Credits

- Video playback uses the official YouTube embedded player.
- Later: film and TV data from TMDB; where-to-watch data from JustWatch.
  This product uses the TMDB API but is not endorsed or certified by TMDB.
