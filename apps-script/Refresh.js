/**
 * The timer job (plan 2.2). A trigger calls timerTick() every 15 min; it runs a refresh
 * only when one is due. Network calls run with no lock held; writes take the script lock.
 */

var RUN_STALE_MS = 6 * 60 * 1000;
var REFRESH_NOW_MIN_GAP_MS = 5 * 60 * 1000;
var META_MAX_AGE_MS = 7 * DAY_MS;
var LIVE_NO_RECHECK_MS = 7 * DAY_MS;
var SHORT_MAX_SEC = 180;

function isoNow_(ms) { return new Date(ms).toISOString(); }

/** Trigger entry point. */
function timerTick() {
  try {
    runRefresh('timer', false);
  } catch (e) {
    setProp('lastError', 'timer: ' + String(e && e.message || e).slice(0, 300));
    deleteProp('refreshRunning');
  }
}

/**
 * Run a refresh. kind: 'timer' | 'now' | 'manual'. force skips the due check (refresh button),
 * but a forced run still waits 5 min after the last start.
 * Returns {ran: false, reason} or {ran: true, run}.
 */
function runRefresh(kind, force) {
  var now = Date.now();
  if (!force) {
    var lastStart = Number(freshProp('lastRefreshStart')) || 0;
    var requested = freshProp('refreshRequested') === '1';
    if (!isRefreshDue(now, lastStart, cfgNum('REFRESH_MINUTES', 60), requested)) return { ran: false, reason: 'not_due' };
  }
  var claim = withLock(function () {
    var running = Number(freshProp('refreshRunning')) || 0;
    if (running && now - running < RUN_STALE_MS) return false;
    if (force && now - (Number(freshProp('lastRefreshStart')) || 0) < REFRESH_NOW_MIN_GAP_MS) return false;
    setProp('refreshRunning', now);
    setProp('lastRefreshStart', now);
    deleteProp('refreshRequested');
    return true;
  });
  if (claim.busy || !claim.value) return { ran: false, reason: 'busy' };

  var ctx = newCtx();
  var run = { time: isoNow_(now), kind: kind, channels: 0, units: 0, newVideos: 0, errors: 0, ms: 0 };
  try {
    refreshBody_(ctx, run, now);
  } catch (e) {
    addError(ctx, 'exception: ' + String(e && e.message || e).slice(0, 200));
  } finally {
    run.units = ctx.units;
    run.errors = ctx.errorTotal;
    run.ms = Date.now() - now;
    try { appendRun(run); } catch (e2) { addError(ctx, 'runs log: ' + String(e2 && e2.message || e2)); }
    setProp('lastRefresh', isoNow_(now));
    setProp('lastError', errorSummary(ctx));
    deleteProp('refreshRunning');
    dlog('refresh done', run);
  }
  return { ran: true, run: run };
}

/**
 * Fetch uploads (and, when asked, live recordings) for channels.
 * known: {videoId: storedRow}. Returns {chanUpdates, newRows, kindUpdates}.
 * chanUpdates: {channelId: fetched fields}; newRows: new video rows (Shorts marked kind 'short');
 * kindUpdates: {videoId: 'live'} for stored videos found in the live playlist.
 */
function fetchUploads(channels, opts, ctx, now) {
  var nowIso = isoNow_(now);
  var chanUpdates = {};
  var cands = {};
  var kindUpdates = {};
  function upd(id) { return chanUpdates[id] || (chanUpdates[id] = { id: id }); }
  function collect(items, channelId, kind, viaUU) {
    items.forEach(function (it) {
      if (!it.published || !inWindow(it.published, now)) return;
      if (opts.known[it.videoId]) {
        if (kind === 'live' && opts.known[it.videoId].kind !== 'live') kindUpdates[it.videoId] = 'live';
        return;
      }
      var c = cands[it.videoId];
      if (!c) cands[it.videoId] = { channelId: channelId, kind: kind, viaUU: viaUU };
      else if (kind === 'live') c.kind = 'live';
    });
  }

  // Uploads: UULF first; on 404 switch the channel to UU for good.
  var first = channels.map(function (c) { return { c: c, pl: c.playlist === 'UU' ? 'UU' : 'LF' }; });
  var heads = fetchPlaylistHeads(first.map(function (x) { return playlistIdFor(x.c.id, x.pl); }), opts.maxResults || 10, ctx);
  var toUU = [];
  heads.forEach(function (r, i) {
    var x = first[i];
    if (r.code === 200) collect(r.items, x.c.id, 'video', x.pl === 'UU');
    else if (r.code === 404 && x.pl === 'LF') { toUU.push(x.c); upd(x.c.id).playlist = 'UU'; }
    else if (r.code === 404) { /* channel has no public uploads */ }
    else if (r.code !== -1) addError(ctx, 'uploads ' + r.code + (r.reason ? ' ' + r.reason : ''));
  });
  if (toUU.length) {
    fetchPlaylistHeads(toUU.map(function (c) { return playlistIdFor(c.id, 'UU'); }), opts.maxResults || 10, ctx)
      .forEach(function (r, i) {
        if (r.code === 200) collect(r.items, toUU[i].id, 'video', true);
        else if (r.code !== 404 && r.code !== -1) addError(ctx, 'uploads UU ' + r.code + (r.reason ? ' ' + r.reason : ''));
      });
  }

  // Live recordings (every LIVE_HOURS): channels with hasLive yes/unknown, or "no" checked over 7 days ago.
  if (opts.live) {
    var liveChans = channels.filter(function (c) {
      if (c.hasLive === 'no') return !c.liveChecked || now - Date.parse(c.liveChecked) >= LIVE_NO_RECHECK_MS;
      return true;
    });
    fetchPlaylistHeads(liveChans.map(function (c) { return playlistIdFor(c.id, 'LV'); }), 10, ctx)
      .forEach(function (r, i) {
        var c = liveChans[i];
        if (r.code === 200) {
          upd(c.id).hasLive = 'yes';
          upd(c.id).liveChecked = nowIso;
          collect(r.items, c.id, 'live', false);
        } else if (r.code === 404) {
          upd(c.id).hasLive = 'no';
          upd(c.id).liveChecked = nowIso;
        } else if (r.code !== -1) addError(ctx, 'live ' + r.code + (r.reason ? ' ' + r.reason : ''));
      });
  }

  // Details for new IDs. Upcoming premieres and running lives are left out until they finish.
  var ids = Object.keys(cands);
  var details = ids.length ? fetchVideoDetails(ids, ctx) : {};
  var newRows = [];
  var shortCheck = [];
  ids.forEach(function (id) {
    if (!details[id]) return;
    var row = videoRowFrom(details[id], cands[id].kind, nowIso);
    if (!row) return;
    if (!row.channelId) row.channelId = cands[id].channelId;
    if (cands[id].viaUU && row.kind !== 'live' && row.durationSec <= SHORT_MAX_SEC) shortCheck.push(row);
    newRows.push(row);
  });
  if (shortCheck.length) {
    var isShort = checkShortsByUrl(shortCheck.map(function (r) { return r.id; }));
    shortCheck.forEach(function (r) {
      if (isShort[r.id] === true) r.kind = 'short';
      else if (isShort[r.id] === null) addError(ctx, 'shorts check failed');
    });
  }
  return { chanUpdates: chanUpdates, newRows: newRows, kindUpdates: kindUpdates };
}

function refreshBody_(ctx, run, now) {
  var nowIso = isoNow_(now);
  var pages = readTable('pages');
  var channels = readTable('channels');
  var videos = readTable('videos');
  var pageSet = pageIdSet(pages);

  // 1. Subscriptions (null when not read in full).
  var subs = fetchSubscriptions(ctx);
  if (ctx.quotaHit) { addError(ctx, 'quota'); return; }
  var target = applySubscriptions(channels, subs, pageSet, nowIso).channels
    .filter(function (c) { return c.subscribed === true || c.addedByLink === true; });
  run.channels = target.length;

  // 2. Uploads and live recordings.
  var liveDue = now - (Number(freshProp('lastLive')) || 0) >= cfgNum('LIVE_HOURS', 6) * 3600000 - 2 * 60000;
  var fetched = fetchUploads(target, { known: indexBy(videos, 'id'), live: liveDue, maxResults: 10 }, ctx, now);

  // 3. Metadata older than 7 days for channels not in the subscription list (subscribed ones got it above).
  var stale = target.filter(function (c) {
    return c.subscribed !== true && (!c.metaUpdated || now - Date.parse(c.metaUpdated) >= META_MAX_AGE_MS);
  }).map(function (c) { return c.id; });
  if (stale.length) {
    var meta = fetchChannelsById(stale, ctx);
    stale.forEach(function (id) {
      var u = fetched.chanUpdates[id] || (fetched.chanUpdates[id] = { id: id });
      var it = meta[id];
      if (it) {
        u.title = it.snippet.title || '';
        u.description = trimDescription(it.snippet.description);
        u.thumb = thumbOf_(it.snippet);
      }
      u.metaUpdated = nowIso;
    });
  }

  // 4. Write (short lock): re-read, merge, purge, write.
  var w = withLock(function () {
    var pagesW = readTable('pages');
    var pageSetW = pageIdSet(pagesW);
    var applied = applySubscriptions(readTable('channels'), subs, pageSetW, nowIso);
    var chans = applied.channels.map(function (c) {
      return fetched.chanUpdates[c.id] ? mergeChannel(c, fetched.chanUpdates[c.id]) : c;
    });
    var alive = indexBy(chans, 'id');
    var vids = readTable('videos');
    var vById = indexBy(vids, 'id');
    var added = 0;
    fetched.newRows.forEach(function (r) {
      if (!alive[r.channelId]) return;
      if (!vById[r.id]) { vids.push(r); if (r.kind !== 'short') added++; }
      vById[r.id] = mergeVideo(vById[r.id], r);
    });
    for (var vid in fetched.kindUpdates) if (vById[vid]) vById[vid] = mergeVideo(vById[vid], { kind: 'live' });
    vids = vids.map(function (v) { return vById[v.id]; }).filter(function (v) { return alive[v.channelId]; });
    var purged = purgeOld(vids, readTable('state'), now);
    writeTable('channels', chans);
    writeTable('videos', purged.videos);
    writeTable('state', purged.states);
    run.newVideos = added;
    return { pages: pagesW, channels: chans, videos: purged.videos };
  });
  if (w.busy) { addError(ctx, 'write busy'); return; }
  if (liveDue && !ctx.quotaHit) setProp('lastLive', now);

  // 5. Gemini page suggestions (no lock while calling Gemini).
  if (w.value.pages.length && cfg('GEMINI_API_KEY')) {
    var res = suggestAndStore(w.value.pages, w.value.channels, w.value.videos, null, ctx);
    if (!res.ok && res.error !== 'nothing_to_do') addError(ctx, res.error);
  }
}
