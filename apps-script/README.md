# media-hub backend (Google Apps Script)

Bound to the owner's Google Sheet "media-hub data". Pushed with clasp
(`.clasp.json` at the repo root, git-ignored, `rootDir: apps-script`).
`.claspignore` pushes only `*.js` and `appsscript.json` from this folder.

## Files

| File | Role |
|---|---|
| `Logic.js` | Pure functions, tested by `tests/backend.test.mjs` (`node --test`). |
| `Config.js` | Script Properties, `dlog()` (only when `DEBUG` is on). |
| `Store.js` | Sheet tabs; every cell JSON-encoded, plain-text format. |
| `YouTube.js` | YouTube Data API through `UrlFetchApp`, retries, unit count. |
| `Refresh.js` | Timer job (`timerTick` every 15 min; runs when due). |
| `Gemini.js` | Page suggestions. |
| `Api.js` | `doPost` JSON API (see `docs/plan-step1.md` section 3). |
| `Setup.js` | One-time `setup()`. |
| `Spike.js` | Key-guarded checks: `spike` action, `kind` = `S1`, `uuPath`, `runs`, `status`, `error`. Counts only. |
| `Secrets.local.js` | **Git-ignored, local only.** Holds the app `KEY`; pushed so `setup()` can copy it into Script Properties. |

## Owner setup (one time)

1. Turn on "Google Apps Script API" at https://script.google.com/home/usersettings.
2. `clasp login` with the personal Gmail. On Google's permission screen, tick the
   boxes (Apps Script projects, deployments, web app deployments, Drive files you
   use with this app, Drive file information). With no box ticked, clasp gets only
   name and email and every command fails with "insufficient authentication scopes".
3. Make a key into `apps-script/Secrets.local.js`:
   `var LOCAL_SECRETS = { KEY: '<64 random hex chars>' };`
4. `clasp create --type sheets --title "media-hub data" --rootDir apps-script`
   (clasp overwrites `appsscript.json`: restore it from git), then `clasp push -f`.
5. In the Apps Script editor run `setup()` once and approve the four scopes.
6. `clasp deploy -d "media-hub"`; keep the deployment ID in `deploy.local.json`
   (git-ignored) and update later with `clasp deploy -i <id>` so the URL stays.
7. Optional: Script Properties `GEMINI_API_KEY` (and `GEMINI_MODEL`, `DEBUG`,
   `REFRESH_MINUTES`, `LIVE_HOURS`).

## App Settings

- Backend URL: the web app `/exec` URL (in `deploy.local.json`, field `execUrl`).
- Key: `KEY` in `apps-script/Secrets.local.js`.
