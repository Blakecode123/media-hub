/**
 * Web-app API (plan section 3). POST, Content-Type text/plain, JSON body {key, action, ...}.
 * Every reply is JSON, also on errors: an uncaught error would give an HTML page with no CORS headers.
 */

function jsonOut_(obj) {
  var text;
  try { text = JSON.stringify(obj); } catch (e) { text = '{"ok":false,"error":"server","message":"reply not serialisable"}'; }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out;
  try {
    out = handleRequest_(e);
  } catch (err) {
    out = { ok: false, error: 'server', message: String(err && err.message || err).slice(0, 300) };
    try { dlog('server error', out.message); } catch (e2) { /* ignore */ }
  }
  return jsonOut_(out);
}

function doGet() {
  return jsonOut_({ ok: false, error: 'use_post' });
}

function handleRequest_(e) {
  var body = null;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || ''); } catch (x) { body = null; }
  if (!body || typeof body !== 'object') body = {};
  // A wrong or missing key gets 'auth' and nothing else.
  if (!checkKey(cfg('KEY'), body.key)) return { ok: false, error: 'auth' };
  var fn = ACTIONS_[body.action];
  if (!fn) return { ok: false, error: 'unknown_action' };
  var t0 = Date.now();
  var out = fn(body);
  dlog('api', body.action, 'ms', Date.now() - t0, 'ok', out && out.ok);
  return out;
}

/** Run a mutating action under the script lock; 'busy' when the lock is not free in 10 s. */
function locked_(fn) {
  var r = withLock(fn);
  return r.busy ? { ok: false, error: 'busy' } : r.value;
}

function makePageId_() {
  return 'p' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function bootstrapReply_() {
  var pages = readTable('pages').sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); });
  var channels = readTable('channels');
  var pageSet = pageIdSet(pages);
  return {
    ok: true,
    pages: pages.map(function (p) { return { id: String(p.id), name: String(p.name || ''), hint: String(p.hint || ''), order: Number(p.order) || 0 }; }),
    channels: channels.map(function (c) { return channelOut(prunePageRefs(c, pageSet)); }),
    videos: videosOut(readTable('videos'), readTable('state')),
    lastRefresh: freshProp('lastRefresh'),
    lastError: freshProp('lastError')
  };
}

var ACTIONS_ = {
  bootstrap: function () {
    return bootstrapReply_();
  },

  setState: function (b) {
    var err = checkSetState(b);
    if (err) return { ok: false, error: err };
    return locked_(function () {
      var r = applyState(readTable('state'), b.items, b.state, new Date().toISOString());
      writeTable('state', r.states);
      return { ok: true, count: r.count };
    });
  },

  rate: function (b) {
    if (typeof b.videoId !== 'string' || !b.videoId || typeof b.channelId !== 'string') return { ok: false, error: 'bad_request' };
    if (b.rating !== null && RATINGS.indexOf(b.rating) < 0) return { ok: false, error: 'bad_rating' };
    return locked_(function () {
      writeTable('state', applyRating(readTable('state'), b.videoId, b.channelId, b.rating, new Date().toISOString()));
      return { ok: true };
    });
  },

  savePages: function (b) {
    var cleaned = cleanPages(b.pages, makePageId_);
    if (cleaned.error) return { ok: false, error: cleaned.error };
    return locked_(function () {
      var pageSet = pageIdSet(cleaned.pages);
      var changed = [];
      var chans = readTable('channels').map(function (c) {
        var n = prunePageRefs(c, pageSet);
        if (JSON.stringify(channelOut(n)) !== JSON.stringify(channelOut(c))) { changed.push(n); return n; }
        return c;
      });
      writeTable('pages', cleaned.pages);
      if (changed.length) writeTable('channels', chans);
      return { ok: true, pages: cleaned.pages, channels: changed.map(channelOut) };
    });
  },

  setChannelPages: function (b) {
    if (typeof b.channelId !== 'string' || !Array.isArray(b.pageIds)) return { ok: false, error: 'bad_request' };
    return locked_(function () {
      var pageSet = pageIdSet(readTable('pages'));
      var chans = readTable('channels');
      var found = null;
      chans = chans.map(function (c) {
        if (c.id !== b.channelId) return c;
        found = shallowCopy(c);
        found.pageIds = toIdList(b.pageIds).filter(function (id, i, a) { return pageSet[id] && a.indexOf(id) === i; });
        return found;
      });
      if (!found) return { ok: false, error: 'not_found' };
      writeTable('channels', chans);
      return { ok: true, channel: channelOut(found) };
    });
  },

  addChannel: function (b) {
    return addChannel_(b.link);
  },

  removeChannel: function (b) {
    if (typeof b.channelId !== 'string') return { ok: false, error: 'bad_request' };
    return locked_(function () {
      var chans = readTable('channels');
      var c = indexBy(chans, 'id')[b.channelId];
      if (!c) return { ok: false, error: 'not_found' };
      if (c.subscribed === true) return { ok: false, error: 'subscribed' };
      writeTable('channels', chans.filter(function (x) { return x.id !== b.channelId; }));
      var vids = readTable('videos').filter(function (v) { return v.channelId !== b.channelId; });
      var purged = purgeOld(vids, readTable('state'), Date.now());
      writeTable('videos', purged.videos);
      writeTable('state', purged.states);
      return { ok: true };
    });
  },

  suggestPages: function (b) {
    var ids = Array.isArray(b.channelIds) && b.channelIds.length ? b.channelIds.filter(function (x) { return typeof x === 'string'; }) : null;
    var res = suggestAndStore(readTable('pages'), readTable('channels'), readTable('videos'), ids, newCtx());
    if (!res.ok && res.error === 'nothing_to_do') return { ok: true, channels: [] };
    return res;
  },

  refreshNow: function () {
    var r = runRefresh('now', true);
    if (!r.ran) return { ok: false, error: 'busy' };
    return bootstrapReply_();
  },

  spike: function (b) {
    return spikeAction(b);
  }
};

/** addChannel: resolve the link, fetch uploads (no lock), then merge under the lock. */
function addChannel_(link) {
  var parsed = parseChannelLink(link);
  if (!parsed) return { ok: false, error: 'bad_link' };
  var ctx = newCtx();
  var item = null;
  if (parsed.kind === 'handle') item = fetchOneChannel({ forHandle: parsed.value }, ctx);
  else if (parsed.kind === 'channelId') item = fetchOneChannel({ id: parsed.value }, ctx);
  else if (parsed.kind === 'username') item = fetchOneChannel({ forUsername: parsed.value }, ctx);
  else if (parsed.kind === 'videoId') {
    var v = fetchVideoDetails([parsed.value], ctx)[parsed.value];
    if (v && v.snippet && v.snippet.channelId) item = fetchOneChannel({ id: v.snippet.channelId }, ctx);
  }
  if (!item) return { ok: false, error: 'not_found' };

  var now = Date.now();
  var nowIso = isoNow_(now);
  var existing = indexBy(readTable('channels'), 'id')[item.id];
  var base = existing || newChannel(item.id);
  var fetched = fetchUploads([base], { known: indexBy(readTable('videos'), 'id'), live: !existing, maxResults: 10 }, ctx, now);

  return locked_(function () {
    var chans = readTable('channels');
    var byId = indexBy(chans, 'id');
    var c = mergeChannel(byId[item.id], {
      id: item.id, title: item.snippet.title || '', description: trimDescription(item.snippet.description),
      thumb: thumbOf_(item.snippet), metaUpdated: nowIso
    });
    if (fetched.chanUpdates[item.id]) c = mergeChannel(c, fetched.chanUpdates[item.id]);
    c.addedByLink = true;
    if (byId[item.id]) chans = chans.map(function (x) { return x.id === item.id ? c : x; });
    else chans.push(c);
    var vids = readTable('videos');
    var vById = indexBy(vids, 'id');
    fetched.newRows.forEach(function (r) {
      if (!vById[r.id]) vids.push(r);
      vById[r.id] = mergeVideo(vById[r.id], r);
    });
    vids = vids.map(function (v) { return vById[v.id]; });
    writeTable('channels', chans);
    writeTable('videos', vids);
    var states = readTable('state');
    return {
      ok: true,
      channel: channelOut(c),
      videos: videosOut(vids.filter(function (v) { return v.channelId === item.id; }), states)
    };
  });
}
