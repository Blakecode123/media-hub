/**
 * YouTube Data API v3 through UrlFetchApp (REST, owner's OAuth token).
 * Every request: muteHttpExceptions, status handled per response, retry with backoff
 * on rate limits and 5xx, quota units counted per run (1 unit per call used here).
 */

var YT_BASE = 'https://www.googleapis.com/youtube/v3/';
var YT_BATCH = 50;
var YT_RETRIES = 3;
var token_ = null;

/** Run context: units used and errors (counted by kind, so the log stays short). */
function newCtx() {
  return { units: 0, errorCounts: {}, errorTotal: 0, quotaHit: false };
}

function addError(ctx, kind) {
  ctx.errorCounts[kind] = (ctx.errorCounts[kind] || 0) + 1;
  ctx.errorTotal++;
  dlog('error', kind);
}

function errorSummary(ctx) {
  var parts = [];
  for (var k in ctx.errorCounts) parts.push(k + (ctx.errorCounts[k] > 1 ? ' x' + ctx.errorCounts[k] : ''));
  return parts.join('; ').slice(0, 500);
}

function oauthToken_() {
  if (!token_) token_ = ScriptApp.getOAuthToken();
  return token_;
}

function queryString_(params) {
  var q = [];
  for (var k in params) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  return q.join('&');
}

/** A YouTube API GET request object for UrlFetchApp.fetchAll. */
function ytReq(path, params) {
  return {
    url: YT_BASE + path + '?' + queryString_(params),
    method: 'get',
    headers: { Authorization: 'Bearer ' + oauthToken_() },
    muteHttpExceptions: true
  };
}

function reasonOf_(data) {
  var e = data && data.error;
  if (!e) return '';
  if (e.errors && e.errors[0] && e.errors[0].reason) return e.errors[0].reason;
  return e.status || '';
}

function isRetryable_(code, reason) {
  if (code === 429 || code >= 500) return true;
  return code === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded');
}

function isQuota_(code, reason) {
  return code === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded');
}

/** fetchAll with a per-request fallback when the batch itself throws (network error). */
function fetchAllSafe_(reqs) {
  try {
    return UrlFetchApp.fetchAll(reqs);
  } catch (e) {
    dlog('fetchAll threw, one by one:', String(e && e.message || e));
    return reqs.map(function (r) {
      try { return UrlFetchApp.fetch(r.url, r); } catch (e2) { return null; }
    });
  }
}

/**
 * Run YouTube requests in batches of 50. Returns, in order, {code, data, reason}.
 * code 0 = network error; code -1 = not sent because the daily quota is used up.
 */
function ytFetchAll(reqs, ctx) {
  var results = new Array(reqs.length);
  var pending = [];
  for (var p = 0; p < reqs.length; p++) pending.push(p);
  for (var attempt = 0; attempt <= YT_RETRIES && pending.length; attempt++) {
    if (attempt > 0) Utilities.sleep(1000 * Math.pow(2, attempt - 1));
    var retry = [];
    for (var b = 0; b < pending.length; b += YT_BATCH) {
      var chunk = pending.slice(b, b + YT_BATCH);
      if (ctx.quotaHit) {
        chunk.forEach(function (i) { results[i] = { code: -1, data: null, reason: 'quotaExceeded' }; });
        continue;
      }
      var resps = fetchAllSafe_(chunk.map(function (i) { return reqs[i]; }));
      ctx.units += chunk.length;
      for (var j = 0; j < chunk.length; j++) {
        var i = chunk[j];
        var r = resps[j];
        if (!r) { results[i] = { code: 0, data: null, reason: 'network' }; retry.push(i); continue; }
        var code = r.getResponseCode();
        var data = null;
        try { data = JSON.parse(r.getContentText()); } catch (e) { data = null; }
        var reason = reasonOf_(data);
        results[i] = { code: code, data: data, reason: reason };
        if (isQuota_(code, reason)) ctx.quotaHit = true;
        else if (isRetryable_(code, reason)) retry.push(i);
      }
    }
    pending = retry;
  }
  return results;
}

/** Thumbnail URL from a snippet (channel avatar). */
function thumbOf_(snippet) {
  var t = snippet && snippet.thumbnails;
  if (!t) return '';
  return (t.medium && t.medium.url) || (t['default'] && t['default'].url) || (t.high && t.high.url) || '';
}

/**
 * All subscriptions of the owner: [{id, title, description, thumb}].
 * Returns null when the list could not be read in full (then nobody is marked unsubscribed).
 */
function fetchSubscriptions(ctx) {
  var out = [];
  var pageToken = '';
  for (var guard = 0; guard < 200; guard++) {
    var params = { part: 'snippet', mine: 'true', maxResults: 50, order: 'alphabetical' };
    if (pageToken) params.pageToken = pageToken;
    var r = ytFetchAll([ytReq('subscriptions', params)], ctx)[0];
    if (r.code !== 200) {
      addError(ctx, 'subscriptions ' + r.code + (r.reason ? ' ' + r.reason : ''));
      return null;
    }
    var items = (r.data && r.data.items) || [];
    for (var i = 0; i < items.length; i++) {
      var s = items[i].snippet || {};
      var cid = s.resourceId && s.resourceId.channelId;
      if (!cid) continue;
      out.push({ id: cid, title: s.title || '', description: trimDescription(s.description), thumb: thumbOf_(s) });
    }
    pageToken = r.data && r.data.nextPageToken;
    if (!pageToken) return out;
  }
  return out;
}

/**
 * Heads of several playlists. Returns, in order, {code, reason, items:[{videoId, published}]}.
 */
function fetchPlaylistHeads(playlistIds, maxResults, ctx) {
  var reqs = playlistIds.map(function (pl) {
    return ytReq('playlistItems', { part: 'contentDetails', playlistId: pl, maxResults: maxResults });
  });
  return ytFetchAll(reqs, ctx).map(function (r) {
    var items = [];
    if (r.code === 200 && r.data && r.data.items) {
      r.data.items.forEach(function (it) {
        var cd = it.contentDetails || {};
        if (cd.videoId) items.push({ videoId: cd.videoId, published: cd.videoPublishedAt || '' });
      });
    }
    return { code: r.code, reason: r.reason, items: items };
  });
}

/** videos.list for many IDs (50 per call). Returns {videoId: item}. */
function fetchVideoDetails(ids, ctx) {
  var reqs = [];
  for (var i = 0; i < ids.length; i += 50) {
    reqs.push(ytReq('videos', { part: 'contentDetails,snippet,liveStreamingDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 }));
  }
  var out = {};
  ytFetchAll(reqs, ctx).forEach(function (r) {
    if (r.code !== 200) { addError(ctx, 'videos ' + r.code + (r.reason ? ' ' + r.reason : '')); return; }
    ((r.data && r.data.items) || []).forEach(function (it) { out[it.id] = it; });
  });
  return out;
}

/** channels.list by IDs (50 per call). Returns {channelId: item}. */
function fetchChannelsById(ids, ctx) {
  var reqs = [];
  for (var i = 0; i < ids.length; i += 50) {
    reqs.push(ytReq('channels', { part: 'snippet', id: ids.slice(i, i + 50).join(','), maxResults: 50 }));
  }
  var out = {};
  ytFetchAll(reqs, ctx).forEach(function (r) {
    if (r.code !== 200) { addError(ctx, 'channels ' + r.code + (r.reason ? ' ' + r.reason : '')); return; }
    ((r.data && r.data.items) || []).forEach(function (it) { out[it.id] = it; });
  });
  return out;
}

/** One channels.list call with any filter (forHandle, forUsername, id). Returns the first item or null. */
function fetchOneChannel(params, ctx) {
  var p = { part: 'snippet', maxResults: 1 };
  for (var k in params) p[k] = params[k];
  var r = ytFetchAll([ytReq('channels', p)], ctx)[0];
  if (r.code !== 200) { addError(ctx, 'channels ' + r.code + (r.reason ? ' ' + r.reason : '')); return null; }
  return (r.data && r.data.items && r.data.items[0]) || null;
}

/**
 * Shorts check by URL (no API units): GET youtube.com/shorts/<id> without following redirects.
 * 200 = Short, 3xx = not a Short. Returns {videoId: true|false|null}.
 * Kept for spike S1 only: from Apps Script, known Shorts also redirect, so refresh uses UUSH instead.
 */
function checkShortsByUrl(ids) {
  var out = {};
  for (var i = 0; i < ids.length; i += 20) {
    var chunk = ids.slice(i, i + 20);
    var resps = fetchAllSafe_(chunk.map(function (id) {
      return { url: 'https://www.youtube.com/shorts/' + encodeURIComponent(id), method: 'get', followRedirects: false, muteHttpExceptions: true };
    }));
    for (var j = 0; j < chunk.length; j++) {
      var r = resps[j];
      var code = r ? r.getResponseCode() : 0;
      out[chunk[j]] = code === 200 ? true : (code >= 300 && code < 400 ? false : null);
    }
  }
  return out;
}

/** A videos.list item to a stored video row. Returns null for upcoming premieres and running lives. */
function videoRowFrom(item, kind, nowIso) {
  var sn = item.snippet || {};
  if (sn.liveBroadcastContent === 'upcoming' || sn.liveBroadcastContent === 'live') return null;
  var dur = isoDurationToSec(item.contentDetails && item.contentDetails.duration);
  return {
    id: item.id, channelId: sn.channelId || '', title: sn.title || '', published: sn.publishedAt || '',
    durationSec: dur === null ? 0 : dur, kind: kind, fetched: nowIso
  };
}
