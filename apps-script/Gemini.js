/**
 * Gemini page suggestions (plan 2.3). Sends only page names/hints, channel titles,
 * descriptions (300 chars) and up to 5 recent video titles.
 */

var GEMINI_BATCH = 50;

function geminiPrompt_(pages, items) {
  return [
    'You sort YouTube channels into the owner\'s pages.',
    'For each channel, choose the page IDs that fit it: zero, one or more.',
    'Use only page IDs from the list. Choose no page when none fits well.',
    'Answer with a JSON array of {"channelId": string, "pageIds": string[]}, one entry per channel.',
    '',
    'Pages:',
    JSON.stringify(pages.map(function (p) { return { id: p.id, name: p.name, hint: p.hint || '' }; })),
    '',
    'Channels:',
    JSON.stringify(items)
  ].join('\n');
}

/**
 * Ask Gemini for suggestions for up to 50 channels.
 * Returns {ok:true, suggestions} or {ok:false, error: 'gemini_busy'|'gemini_error'|'no_gemini_key'}.
 */
function geminiSuggest(pages, channels, videos) {
  var key = cfg('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'no_gemini_key' };
  var byChan = {};
  videosOut(videos, []).forEach(function (v) {
    var l = byChan[v.channelId] || (byChan[v.channelId] = []);
    if (l.length < 5) l.push(v.title);
  });
  var items = channels.map(function (c) {
    return { channelId: c.id, title: String(c.title || ''), description: trimDescription(String(c.description || '')), recentVideoTitles: byChan[c.id] || [] };
  });
  var body = {
    contents: [{ role: 'user', parts: [{ text: geminiPrompt_(pages, items) }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { channelId: { type: 'STRING' }, pageIds: { type: 'ARRAY', items: { type: 'STRING' } } },
          required: ['channelId', 'pageIds']
        }
      }
    }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg('GEMINI_MODEL')) + ':generateContent';
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: 'gemini_error', message: 'network' };
  }
  var code = resp.getResponseCode();
  dlog('gemini status', code, 'channels', channels.length);
  if (code === 429) return { ok: false, error: 'gemini_busy' };
  if (code !== 200) return { ok: false, error: 'gemini_error', message: 'HTTP ' + code };
  var text = '';
  try {
    var data = JSON.parse(resp.getContentText());
    var parts = data.candidates[0].content.parts;
    text = parts.map(function (p) { return p.text || ''; }).join('');
  } catch (e2) {
    return { ok: false, error: 'gemini_error', message: 'empty reply' };
  }
  var pageIds = pages.map(function (p) { return p.id; });
  var checked = checkGeminiOutput(text, pageIds, channels.map(function (c) { return c.id; }));
  if (!checked.ok) return { ok: false, error: 'gemini_error', message: checked.error };
  return checked;
}

/**
 * Pick channels, ask Gemini (no lock), then write suggestions under a short lock.
 * channelIds: null for the automatic run (channels that need a suggestion), else the given channels.
 * Returns {ok, channels (changed, API shape)} or {ok:false, error}.
 */
function suggestAndStore(pages, channels, videos, channelIds, ctx) {
  if (!pages.length) return { ok: false, error: 'no_pages' };
  if (!cfg('GEMINI_API_KEY')) return { ok: false, error: 'no_gemini_key' };
  var pageSet = pageIdSet(pages);
  var pick;
  if (channelIds) {
    var want = {};
    channelIds.forEach(function (id) { want[id] = true; });
    pick = channels.filter(function (c) { return want[c.id]; });
  } else {
    pick = channels.filter(function (c) { return needsSuggestion(c, pageSet); });
  }
  pick = pick.slice(0, GEMINI_BATCH);
  if (!pick.length) return channelIds ? { ok: true, channels: [] } : { ok: false, error: 'nothing_to_do' };

  var res = geminiSuggest(pages, pick, videos);
  if (!res.ok) return res;

  var w = withLock(function () {
    var pagesW = readTable('pages');
    var pageSetW = pageIdSet(pagesW);
    var all = readTable('channels');
    var changed = [];
    all = all.map(function (c) {
      if (!Object.prototype.hasOwnProperty.call(res.suggestions, c.id)) return c;
      var s = res.suggestions[c.id];
      var n = shallowCopy(c);
      n.suggestedPageIds = s === 'none' ? 'none' : s.filter(function (id) { return pageSetW[id]; });
      if (Array.isArray(n.suggestedPageIds) && n.suggestedPageIds.length === 0) n.suggestedPageIds = 'none';
      changed.push(n);
      return n;
    });
    writeTable('channels', all);
    return changed;
  });
  if (w.busy) return { ok: false, error: 'busy' };
  return { ok: true, channels: w.value.map(channelOut) };
}
