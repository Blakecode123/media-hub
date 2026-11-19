/**
 * Pure functions for the media-hub backend.
 * No Apps Script services here: tests load this file in a Node `vm` context.
 * Use `function` and `var` at top level so both Apps Script and `vm` see them as globals.
 */

var WINDOW_DAYS = 30;
var DAY_MS = 24 * 60 * 60 * 1000;
var VIDEO_STATES = ['watched', 'seen', 'hidden'];
var RATINGS = ['up', 'down'];

/** Fields that only the owner changes. Merges of fetched data never touch them. */
var OWNER_CHANNEL_FIELDS = ['pageIds', 'suggestedPageIds', 'addedByLink'];

/** Fields that a refresh may write on a channel. */
var FETCH_CHANNEL_FIELDS = ['title', 'description', 'thumb', 'subscribed', 'playlist',
  'hasLive', 'liveChecked', 'metaUpdated'];

/** Fields that a refresh may write on a video. */
var FETCH_VIDEO_FIELDS = ['channelId', 'title', 'published', 'durationSec', 'kind', 'fetched'];

// ---------- Channel links ----------

/**
 * Parse what the owner pastes to add a channel.
 * Returns {kind: 'handle'|'channelId'|'username'|'videoId', value} or null.
 */
function parseChannelLink(input) {
  if (typeof input !== 'string') return null;
  var s = input.trim();
  if (!s) return null;

  if (/^@[A-Za-z0-9._-]{3,100}$/.test(s)) return { kind: 'handle', value: s };
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return { kind: 'channelId', value: s };

  var url = s;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  var m = /^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i.exec(url);
  if (!m) return null;
  var host = m[1].toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  var path = m[2] || '';
  var query = m[3] || '';

  if (host === 'youtu.be') {
    var short = /^\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(path);
    return short ? { kind: 'videoId', value: short[1] } : null;
  }
  if (host !== 'youtube.com') return null;

  var p;
  if ((p = /^\/(@[A-Za-z0-9._-]{3,100})(?:\/|$)/.exec(path))) {
    return { kind: 'handle', value: decodeURIComponent(p[1]) };
  }
  if ((p = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(path))) {
    return { kind: 'channelId', value: p[1] };
  }
  if ((p = /^\/user\/([A-Za-z0-9._-]{1,100})(?:\/|$)/.exec(path))) {
    return { kind: 'username', value: p[1] };
  }
  if ((p = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(path))) {
    return { kind: 'videoId', value: p[1] };
  }
  if (path === '/watch' || path === '/watch/') {
    var v = /[?&]v=([A-Za-z0-9_-]{11})(?:&|$)/.exec(query);
    return v ? { kind: 'videoId', value: v[1] } : null;
  }
  return null;
}

// ---------- Playlist IDs ----------

/**
 * Playlist ID for a channel.
 * kind: 'UU' = all uploads, 'LF' = videos without Shorts, 'LV' = live recordings.
 */
function playlistIdFor(channelId, kind) {
  if (typeof channelId !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return null;
  var rest = channelId.slice(2);
  if (kind === 'UU') return 'UU' + rest;
  if (kind === 'LF') return 'UULF' + rest;
  if (kind === 'LV') return 'UULV' + rest;
  return null;
}

// ---------- Durations and dates ----------

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H", "P0D") to seconds; null if not valid. */
function isoDurationToSec(iso) {
  if (typeof iso !== 'string') return null;
  var m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m || iso === 'P' || /T$/.test(iso)) return null;
  var w = +(m[1] || 0), d = +(m[2] || 0), h = +(m[3] || 0), min = +(m[4] || 0), s = +(m[5] || 0);
  return Math.round(((w * 7 + d) * 24 + h) * 3600 + min * 60 + s);
}

/** True when an ISO date is inside the window (default 30 days) before nowMs. */
function inWindow(isoDate, nowMs, days) {
  var t = Date.parse(isoDate);
  if (isNaN(t)) return false;
  return nowMs - t <= (days || WINDOW_DAYS) * DAY_MS;
}

/** True when the refresh job is due (2.2 step 1). */
function isRefreshDue(nowMs, lastStartMs, refreshMinutes, requested) {
  if (requested) return true;
  if (!lastStartMs) return true;
  return nowMs - lastStartMs >= (refreshMinutes - 2) * 60 * 1000;
}

// ---------- Purge (30-day rule) ----------

/**
 * Keep videos published inside the window. For state rows whose video is gone:
 * drop them, unless they have a rating; a rated row keeps only videoId, channelId, rating.
 * Returns {videos, states, droppedVideos}.
 */
function purgeOld(videos, states, nowMs) {
  var keepVideos = [];
  var kept = {};
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    if (inWindow(v.published, nowMs)) {
      keepVideos.push(v);
      kept[v.id] = true;
    }
  }
  var keepStates = [];
  for (var j = 0; j < states.length; j++) {
    var s = states[j];
    if (kept[s.videoId]) {
      keepStates.push(s);
    } else if (RATINGS.indexOf(s.rating) >= 0) {
      keepStates.push({ videoId: s.videoId, channelId: s.channelId, state: '', rating: s.rating, updated: '' });
    }
  }
  return { videos: keepVideos, states: keepStates, droppedVideos: videos.length - keepVideos.length };
}

// ---------- Pages and the Other rule ----------

/** Page IDs that exist, as a lookup object. */
function pageIdSet(pages) {
  var set = {};
  for (var i = 0; i < pages.length; i++) set[pages[i].id] = true;
  return set;
}

/** Page IDs of a channel that point to existing pages. */
function livePageIds(channel, pageSet) {
  var ids = toIdList(channel.pageIds);
  var out = [];
  for (var i = 0; i < ids.length; i++) if (pageSet[ids[i]]) out.push(ids[i]);
  return out;
}

/** Other rule: a subscribed channel is in Other when none of its pageIds is an existing page. */
function isInOther(channel, pageSet) {
  return channel.subscribed === true && livePageIds(channel, pageSet).length === 0;
}

/** Normalise a page-ID list value (array or comma string) to an array of non-empty strings. */
function toIdList(v) {
  if (Array.isArray(v)) return v.filter(function (x) { return typeof x === 'string' && x; });
  if (typeof v === 'string' && v && v !== 'none') {
    return v.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }
  return [];
}

/** Valid page ID: 1-40 chars of letters, digits, _ or -. "none" is reserved. */
function isValidPageId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) && id !== 'none';
}

/**
 * Check a full pages list from the client. Returns {pages, error}.
 * Missing IDs are filled by makeId(); order is renumbered 0..n-1 in list order.
 */
function cleanPages(list, makeId) {
  if (!Array.isArray(list)) return { error: 'bad_request' };
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i] || {};
    var id = p.id ? p.id : makeId();
    if (!isValidPageId(id) || seen[id]) return { error: 'bad_page_id' };
    var name = typeof p.name === 'string' ? p.name.trim().slice(0, 100) : '';
    if (!name) return { error: 'bad_page_name' };
    seen[id] = true;
    out.push({ id: id, name: name, hint: typeof p.hint === 'string' ? p.hint.slice(0, 500) : '', order: out.length });
  }
  return { pages: out };
}

/** Remove page IDs that no longer exist from a channel's pageIds and suggestedPageIds. */
function prunePageRefs(channel, pageSet) {
  var c = shallowCopy(channel);
  c.pageIds = livePageIds(channel, pageSet);
  if (channel.suggestedPageIds !== 'none') {
    var sug = toIdList(channel.suggestedPageIds).filter(function (id) { return pageSet[id]; });
    var hadSug = toIdList(channel.suggestedPageIds).length > 0;
    // A suggestion list that loses all its pages becomes "none", so the AI does not loop on it.
    c.suggestedPageIds = hadSug && sug.length === 0 ? 'none' : sug;
  }
  return c;
}

// ---------- Merge rules ----------

function shallowCopy(o) {
  var c = {};
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
  return c;
}

/** New channel row with defaults. */
function newChannel(id) {
  return {
    id: id, title: '', description: '', thumb: '', subscribed: false, addedByLink: false,
    pageIds: [], suggestedPageIds: [], playlist: 'LF', hasLive: 'unknown', liveChecked: '', metaUpdated: ''
  };
}

/**
 * Merge fetched channel data into an existing row (or a new one).
 * Only FETCH_CHANNEL_FIELDS are copied; owner fields never change.
 */
function mergeChannel(existing, fetched) {
  var c = existing ? shallowCopy(existing) : newChannel(fetched.id);
  for (var i = 0; i < FETCH_CHANNEL_FIELDS.length; i++) {
    var f = FETCH_CHANNEL_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(fetched, f) && fetched[f] !== undefined) c[f] = fetched[f];
  }
  return c;
}

/** Merge fetched video data into an existing row (or a new one). Only FETCH_VIDEO_FIELDS are copied. */
function mergeVideo(existing, fetched) {
  var v = existing ? shallowCopy(existing) : { id: fetched.id };
  for (var i = 0; i < FETCH_VIDEO_FIELDS.length; i++) {
    var f = FETCH_VIDEO_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(fetched, f) && fetched[f] !== undefined) v[f] = fetched[f];
  }
  return v;
}

/** Index a list of rows by a key field. */
function indexBy(rows, key) {
  var m = {};
  for (var i = 0; i < rows.length; i++) m[rows[i][key]] = rows[i];
  return m;
}

/**
 * Apply subscription results to the channel list.
 * subs: [{id, title, description, thumb}] (a complete list) or null when the fetch did not finish.
 * Returns {channels, removedIds}. New subscriptions get no pages (they show in Other).
 * Gone subscriptions: subscribed=false; deleted only when in no existing page and not added by link.
 */
function applySubscriptions(channels, subs, pageSet, nowIso) {
  var byId = indexBy(channels, 'id');
  var out = [];
  var removedIds = [];
  if (!subs) return { channels: channels.slice(), removedIds: removedIds };
  var subIds = {};
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    subIds[s.id] = true;
    var merged = mergeChannel(byId[s.id], {
      id: s.id, title: s.title, description: s.description, thumb: s.thumb,
      subscribed: true, metaUpdated: nowIso
    });
    byId[s.id] = merged;
  }
  var order = channels.map(function (c) { return c.id; });
  for (var k = 0; k < subs.length; k++) if (order.indexOf(subs[k].id) < 0) order.push(subs[k].id);
  for (var j = 0; j < order.length; j++) {
    var c = byId[order[j]];
    if (!subIds[c.id] && c.subscribed === true) {
      c = shallowCopy(c);
      c.subscribed = false;
      if (livePageIds(c, pageSet).length === 0 && c.addedByLink !== true) {
        removedIds.push(c.id);
        continue;
      }
    }
    out.push(c);
  }
  return { channels: out, removedIds: removedIds };
}

// ---------- Video state ----------

/**
 * Apply a setState call to the state rows. state: 'watched'|'seen'|'hidden'|null.
 * Clearing a state keeps a row only if it has a rating.
 */
function applyState(states, items, state, nowIso) {
  var byId = indexBy(states, 'videoId');
  var count = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var row = byId[it.videoId] ? shallowCopy(byId[it.videoId]) : { videoId: it.videoId, channelId: it.channelId, state: '', rating: '', updated: '' };
    row.state = state || '';
    row.updated = nowIso;
    if (!row.channelId) row.channelId = it.channelId;
    byId[it.videoId] = row;
    count++;
  }
  return { states: compactStates(states, byId), count: count };
}

/** Apply a rating. A rating also sets the video to watched. rating null clears only the rating. */
function applyRating(states, videoId, channelId, rating, nowIso) {
  var byId = indexBy(states, 'videoId');
  var row = byId[videoId] ? shallowCopy(byId[videoId]) : { videoId: videoId, channelId: channelId, state: '', rating: '', updated: '' };
  row.rating = rating || '';
  if (rating) row.state = 'watched';
  row.updated = nowIso;
  byId[videoId] = row;
  return compactStates(states, byId);
}

/** Rebuild the state list from the lookup, keeping order; drop rows with no state and no rating. */
function compactStates(states, byId) {
  var out = [];
  var done = {};
  var ids = states.map(function (s) { return s.videoId; });
  for (var k in byId) if (ids.indexOf(k) < 0) ids.push(k);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (done[id]) continue;
    done[id] = true;
    var r = byId[id];
    if (r && (r.state || r.rating)) out.push(r);
  }
  return out;
}

/** Check a setState request. Returns an error code or ''. */
function checkSetState(body) {
  if (!body || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 1000) return 'bad_request';
  if (body.state !== null && VIDEO_STATES.indexOf(body.state) < 0) return 'bad_state';
  for (var i = 0; i < body.items.length; i++) {
    var it = body.items[i];
    if (!it || typeof it.videoId !== 'string' || !it.videoId || typeof it.channelId !== 'string') return 'bad_request';
  }
  return '';
}

// ---------- Key check ----------

/** Strict key check: stored key is a string of 32+ chars and equals the given key. */
function checkKey(stored, given) {
  if (typeof stored !== 'string' || stored.length < 32) return false;
  if (typeof given !== 'string' || given.length !== stored.length) return false;
  var diff = 0;
  for (var i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---------- Gemini output check ----------

/**
 * Check Gemini output for page suggestions.
 * raw: the JSON text (or parsed value) of [{channelId, pageIds[]}].
 * Unknown page and channel IDs are dropped. A requested channel with no valid page gets 'none'.
 * Returns {ok, suggestions: {channelId: [pageIds] | 'none'}} or {ok:false, error}.
 */
function checkGeminiOutput(raw, pageIds, requestedChannelIds) {
  var data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch (e) { return { ok: false, error: 'bad_json' }; }
  }
  if (!Array.isArray(data)) return { ok: false, error: 'not_array' };
  var pageOk = {};
  for (var i = 0; i < pageIds.length; i++) pageOk[pageIds[i]] = true;
  var asked = {};
  for (var j = 0; j < requestedChannelIds.length; j++) asked[requestedChannelIds[j]] = true;

  var found = {};
  for (var k = 0; k < data.length; k++) {
    var item = data[k];
    if (!item || typeof item.channelId !== 'string' || !asked[item.channelId]) continue;
    var ids = Array.isArray(item.pageIds) ? item.pageIds : [];
    var good = found[item.channelId] || [];
    for (var n = 0; n < ids.length; n++) {
      if (pageOk[ids[n]] && good.indexOf(ids[n]) < 0) good.push(ids[n]);
    }
    found[item.channelId] = good;
  }
  var out = {};
  for (var r = 0; r < requestedChannelIds.length; r++) {
    var cid = requestedChannelIds[r];
    out[cid] = found[cid] && found[cid].length ? found[cid] : 'none';
  }
  return { ok: true, suggestions: out };
}

/** Channels the automatic Gemini run should look at: no live pages and no suggestion yet. */
function needsSuggestion(channel, pageSet) {
  if (livePageIds(channel, pageSet).length > 0) return false;
  if (channel.suggestedPageIds === 'none') return false;
  return toIdList(channel.suggestedPageIds).length === 0;
}

// ---------- Sheet cells ----------

/**
 * Every cell is stored JSON-encoded so Sheets never reads text as a formula, date or number.
 * Empty values are stored as an empty cell.
 */
function encodeCell(v) {
  if (v === null || v === undefined || v === '') return '';
  return JSON.stringify(v);
}

/** Read a cell written by encodeCell. A hand-typed cell that is not JSON is kept as text. */
function decodeCell(v) {
  if (typeof v !== 'string') return v === null || v === undefined ? '' : v;
  if (v === '') return '';
  try { return JSON.parse(v); } catch (e) { return v; }
}

/** Rows of objects to a 2-D array in column order. */
function rowsToValues(rows, columns) {
  return rows.map(function (r) {
    return columns.map(function (c) { return encodeCell(r[c]); });
  });
}

/** 2-D array (header row first) to rows of objects; unknown columns are ignored, missing ones are ''. */
function valuesToRows(values, columns) {
  if (!values || values.length === 0) return [];
  var header = values[0].map(function (h) { return String(h).trim(); });
  var idx = columns.map(function (c) { return header.indexOf(c); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var blank = true;
    for (var b = 0; b < row.length; b++) if (row[b] !== '' && row[b] !== null) { blank = false; break; }
    if (blank) continue;
    var o = {};
    for (var j = 0; j < columns.length; j++) o[columns[j]] = idx[j] >= 0 ? decodeCell(row[idx[j]]) : '';
    out.push(o);
  }
  return out;
}

// ---------- Bootstrap shape ----------

/** Channel row to the API shape. */
function channelOut(c) {
  return {
    id: c.id, title: String(c.title || ''), description: String(c.description || ''), thumb: String(c.thumb || ''),
    subscribed: c.subscribed === true, addedByLink: c.addedByLink === true,
    pageIds: toIdList(c.pageIds),
    suggestedPageIds: c.suggestedPageIds === 'none' ? 'none' : toIdList(c.suggestedPageIds),
    hasLive: c.hasLive || 'unknown'
  };
}

/** Videos for the API: no Shorts, newest first, with state and rating merged in. */
function videosOut(videos, states) {
  var st = indexBy(states, 'videoId');
  var out = [];
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    if (v.kind === 'short') continue;
    var s = st[v.id] || {};
    out.push({
      id: String(v.id), channelId: v.channelId, title: String(v.title || ''), published: v.published,
      durationSec: Number(v.durationSec) || 0, live: v.kind === 'live',
      state: s.state || null, rating: s.rating || null
    });
  }
  out.sort(function (a, b) { return a.published < b.published ? 1 : a.published > b.published ? -1 : 0; });
  return out;
}

/** Trim a description to the stored length. */
function trimDescription(s) {
  return typeof s === 'string' ? s.slice(0, 300) : '';
}
