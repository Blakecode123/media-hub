/**
 * Key-guarded checks for the step-1 spikes and for diagnosis. Replies hold counts only:
 * no channel names, IDs or titles.
 * body.kind: 'S1' (playlist check), 'runs' (last run rows), 'status' (settings present), 'error' (forced error).
 */

function spikeAction(b) {
  if (b.kind === 'S1') return spikeS1_(b);
  if (b.kind === 'runs') return { ok: true, runs: lastRuns(Math.min(Number(b.n) || 10, 200)) };
  if (b.kind === 'status') return spikeStatus_();
  if (b.kind === 'error') throw new Error('forced test error');
  return { ok: false, error: 'bad_request' };
}

function spikeStatus_() {
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'timerTick'; }).length;
  return {
    ok: true,
    keySet: cfg('KEY').length >= 32,
    geminiKeySet: !!cfg('GEMINI_API_KEY'),
    geminiModel: cfg('GEMINI_MODEL'),
    refreshMinutes: cfgNum('REFRESH_MINUTES', 60),
    liveHours: cfgNum('LIVE_HOURS', 6),
    debug: isDebug(),
    timerTriggers: triggers,
    lastRefresh: freshProp('lastRefresh'),
    lastError: freshProp('lastError'),
    rows: { pages: readTable('pages').length, channels: readTable('channels').length, videos: readTable('videos').length, state: readTable('state').length }
  };
}

function countBy_(list, fn) {
  var out = {};
  list.forEach(function (x) { var k = String(fn(x)); out[k] = (out[k] || 0) + 1; });
  return out;
}

/** Oldest published time of a full playlist page (50 items), or -Infinity when the list is complete. */
function spanLimit_(items, max) {
  if (items.length < max) return -Infinity;
  var t = Infinity;
  items.forEach(function (it) { var p = Date.parse(it.published); if (!isNaN(p) && p < t) t = p; });
  return t === Infinity ? -Infinity : t;
}

function spikeS1_(b) {
  var t0 = Date.now();
  var ctx = newCtx();
  var subs = fetchSubscriptions(ctx);
  if (!subs) return { ok: false, error: 'subscriptions_failed', errors: errorSummary(ctx) };
  var n = b.limit ? Math.min(Number(b.limit), subs.length) : subs.length;
  var ids = subs.slice(0, n).map(function (s) { return s.id; });
  var MAX = 50;
  function pl(id, k) { return k === 'SH' ? 'UUSH' + id.slice(2) : playlistIdFor(id, k); }
  var res = {};
  ['LF', 'UU', 'LV', 'SH'].forEach(function (k) {
    res[k] = fetchPlaylistHeads(ids.map(function (id) { return pl(id, k); }), MAX, ctx);
  });
  var status = {};
  ['LF', 'UU', 'LV', 'SH'].forEach(function (k) { status[k] = countBy_(res[k], function (r) { return r.code; }); });

  var cmp = {
    channelsCompared: 0, lfItems: 0, shortsInLF: 0, livesInLF: 0, lfNotInUU: 0,
    uuOnlyItems: 0, uuOnlyShorts: 0, uuOnlyLives: 0, uuOnlyUnexplained: 0,
    lf404: 0, lf404WithUU200: 0, lf404WithSH200: 0, lf404WithLV200: 0
  };
  var knownShorts = [], lfSample = [], unexplained = [];
  for (var i = 0; i < ids.length; i++) {
    var lf = res.LF[i], uu = res.UU[i], lv = res.LV[i], sh = res.SH[i];
    if (lf.code === 404) {
      cmp.lf404++;
      if (uu.code === 200) cmp.lf404WithUU200++;
      if (sh.code === 200) cmp.lf404WithSH200++;
      if (lv.code === 200) cmp.lf404WithLV200++;
    }
    if (lf.code !== 200 || uu.code !== 200) continue;
    cmp.channelsCompared++;
    var set = function (r) { var s = {}; if (r.code === 200) r.items.forEach(function (it) { s[it.videoId] = true; }); return s; };
    var lfIds = set(lf), uuIds = set(uu), shIds = set(sh), lvIds = set(lv);
    var start = Math.max(spanLimit_(uu.items, MAX), spanLimit_(lf.items, MAX));
    uu.items.forEach(function (it) {
      var p = Date.parse(it.published);
      if (isNaN(p) || p < start || lfIds[it.videoId]) return;
      cmp.uuOnlyItems++;
      if (shIds[it.videoId]) cmp.uuOnlyShorts++;
      else if (lvIds[it.videoId]) cmp.uuOnlyLives++;
      else { cmp.uuOnlyUnexplained++; if (unexplained.length < 50) unexplained.push(it.videoId); }
    });
    lf.items.forEach(function (it) {
      var p = Date.parse(it.published);
      if (isNaN(p) || p < start) return;
      cmp.lfItems++;
      if (shIds[it.videoId]) cmp.shortsInLF++;
      if (lvIds[it.videoId]) cmp.livesInLF++;
      if (!uuIds[it.videoId]) cmp.lfNotInUU++;
    });
    if (sh.code === 200 && knownShorts.length < 40) knownShorts = knownShorts.concat(sh.items.slice(0, 2).map(function (x) { return x.videoId; }));
    if (lfSample.length < 50) lfSample = lfSample.concat(lf.items.slice(0, 3).map(function (x) { return x.videoId; }));
  }
  knownShorts = knownShorts.slice(0, 40);
  lfSample = lfSample.slice(0, 50);

  // Shorts URL check: known Shorts should give 200; UULF videos should redirect (3xx).
  var urlOnShorts = checkShortsByUrl(knownShorts);
  var lfDetails = fetchVideoDetails(lfSample, ctx);
  var urlOnLF = checkShortsByUrl(lfSample);
  var lfShortLen = lfSample.filter(function (id) {
    var d = lfDetails[id] && isoDurationToSec(lfDetails[id].contentDetails.duration);
    return d !== null && d !== undefined && d <= SHORT_MAX_SEC;
  });

  // Items only in UU that are neither in UUSH nor UULV.
  var unDetails = unexplained.length ? fetchVideoDetails(unexplained, ctx) : {};
  var unUrl = checkShortsByUrl(unexplained);
  var unexplainedInfo = countBy_(unexplained, function (id) {
    var d = unDetails[id];
    if (!d) return 'not_returned';
    var lbc = d.snippet && d.snippet.liveBroadcastContent;
    if (lbc && lbc !== 'none') return 'broadcast_' + lbc;
    if (d.liveStreamingDetails) return 'has_live_details';
    var sec = isoDurationToSec(d.contentDetails.duration);
    return (sec <= SHORT_MAX_SEC ? 'le180s' : 'gt180s') + '_url_' + (unUrl[id] === true ? 'short' : unUrl[id] === false ? 'not_short' : 'unknown');
  });

  return {
    ok: true,
    subscriptions: subs.length,
    tested: n,
    playlistStatus: status,
    compare: cmp,
    shortsUrlCheck: {
      knownShorts: countBy_(knownShorts, function (id) { return urlOnShorts[id]; }),
      lfVideos: countBy_(lfSample, function (id) { return urlOnLF[id]; }),
      lfVideosUpTo180s: countBy_(lfShortLen, function (id) { return urlOnLF[id]; })
    },
    uuOnlyUnexplainedSample: unexplainedInfo,
    units: ctx.units,
    errors: errorSummary(ctx),
    ms: Date.now() - t0
  };
}
