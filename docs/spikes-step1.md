# Step-1 spike results

Run 2026-11-19 through the deployed web app (key-guarded `spike` action), on the
owner's real account. Counts only; no channel names or IDs.

## Summary

| # | Question | Result |
|---|---|---|
| S1 | Do `UULF` and `UULV` work in `playlistItems.list`? | **Pass.** `UULF` works for 213 of 213 channels. |
| S2 | Can a browser on another origin call the web app? | **Pass.** |
| S4 | Channel count and quota units | **Pass.** 213 channels, about 5,700 units a day at hourly refresh. |
| S3 | Authorization still works after 8 days? | Not run yet: check the `runs` tab on or after 2026-11-27. |

## S1: playlists

All 213 subscribed channels; 50 newest items of each playlist (858 units, 77 s).

| Playlist | HTTP 200 | HTTP 404 |
|---|---|---|
| `UULF` (videos, no Shorts) | 213 | 0 |
| `UU` (all uploads) | 213 | 0 |
| `UULV` (live recordings) | 105 | 108 |
| `UUSH` (Shorts) | 185 | 28 |

Comparison inside the time span that both `UU` and `UULF` lists cover:

| Check | Count |
|---|---|
| `UULF` items compared | 6,116 |
| Shorts (`UUSH`) found in `UULF` | 0 |
| Live recordings (`UULV`) found in `UULF` | 0 |
| Items only in `UU` | 4,043 |
| ... of which Shorts | 3,927 |
| ... of which live recordings | 116 |
| ... not explained | 0 |
| `UULF` items missing from `UU` (playlist order, not a problem) | 37 |

Findings:
- `UULF` holds no Shorts and no live recordings. Live recordings need `UULV`,
  as the design says.
- The plan's fallback Shorts check (`GET youtube.com/shorts/<id>`, no redirect)
  **does not work** from Apps Script: 40 of 40 known Shorts returned a redirect,
  the same as 50 of 50 normal videos. So the fallback for a channel whose `UULF`
  gives 404 now uses the channel's `UUSH` playlist to drop Shorts (1 unit per
  such channel per refresh). Check with 8 channels forced onto `UU`: 30 Shorts
  dropped, 30 videos kept, 0 kept videos missing from `UULF`. Today no channel
  needs the fallback.

## S2: cross-origin calls

`fetch(execUrl, {method:'POST', headers:{'Content-Type':'text/plain'}, body})`:

| From | Wrong key | Body not JSON | Forced server error | Real `bootstrap` |
|---|---|---|---|---|
| Browser, `http://localhost` page | JSON `auth` | JSON `auth` | JSON `server` | JSON, ok |
| curl with `Origin: https://blakecode123.github.io` | JSON `auth`; both the 302 and the final 200 send `Access-Control-Allow-Origin: *` | | | |

A browser test from the Pages page itself was not possible here (the test page
could not read the URL and key from this PC). The main chat's integration check
covers it. The headers above show the origin does not matter.

`bootstrap` takes about 6-10 s (213 channels, 591 videos). The frontend shows
its cached copy first, so this is acceptable for step 1.

## Gemini page suggestions (extra check)

No-write test (`spike` kind `gemini`): 4 generic test pages, the first 10
channels, free-tier key, `thinkingLevel: low`.

| Model | Gemini call time | Result |
|---|---|---|
| `gemini-3.5-flash-lite` | 1.9 s | ok: 2 channels got a page, 8 got `none` |
| `gemini-3.8-flash` | 251 s | ok: 1 channel got a page, 9 got `none` |
| `gemini-flash-latest` | over 300 s | test client gave up |

The default model is now `gemini-3.5-flash-lite`: the Flash models are too slow
on the free tier for a refresh run (50 channels per call). Same tokens in and
out (about 1,200 in, 400 out per 10 channels). Many `none` results are expected
with generic test pages.

## S4: channels and quota

Run log (`runs` tab):

| Run | Channels | Units | New videos | Errors | Time |
|---|---|---|---|---|---|
| First timer run (uploads + live) | 213 | 443 | 591 | 0 | 48 s |
| Refresh button (uploads only) | 213 | 219 | 0 | 0 | 20 s |
| Refresh button (uploads only) | 213 | 219 | 0 | 0 | 19 s |

Units a day at `REFRESH_MINUTES = 60`:
- Hourly uploads: 24 x 219 = 5,256.
- Live recordings every 6 h: 4 x about 105 = about 420 (channels without a live
  playlist are checked again only every 7 days: about 15 a day).
- Total: about 5,700 of the 10,000 daily units, under the 8,000 target.
  Hourly refresh stays under 8,000 up to about 300 channels. No change to
  `REFRESH_MINUTES`.
