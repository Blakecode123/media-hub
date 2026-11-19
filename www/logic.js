// Pure functions for media-hub. No DOM, no network: tested in Node (tests/frontend.test.mjs).
// Data shape is the `bootstrap` reply of the API contract (docs/plan-step1.md section 3),
// after normalize(): pages[], channels[] (pageIds[] and suggestedPageIds[] | 'none'),
// videos[] (state, rating merged in).

export const WINDOW_DAYS = 30;
const DAY_MS = 86400000;
const STATES = new Set(['watched', 'seen', 'hidden']);
const RATINGS = new Set(['up', 'down']);

// ---- normalizing ----

function toList(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (v == null || v === '') return [];
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function toBool(v) {
  return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1' || v === 'yes';
}

function toMs(v) {
  if (typeof v === 'number') return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

export function normalizeChannel(c) {
  const sugg = c.suggestedPageIds;
  return {
    ...c,
    id: String(c.id),
    title: c.title == null ? '' : String(c.title),
    description: c.description == null ? '' : String(c.description),
    subscribed: toBool(c.subscribed),
    addedByLink: toBool(c.addedByLink),
    pageIds: toList(c.pageIds),
    suggestedPageIds: sugg === 'none' ? 'none' : toList(sugg),
  };
}

export function normalizeVideo(v) {
  const state = STATES.has(v.state) ? v.state : null;
  const rating = RATINGS.has(v.rating) ? v.rating : null;
  return {
    ...v,
    id: String(v.id),
    channelId: String(v.channelId),
    title: v.title == null ? '' : String(v.title),
    publishedMs: toMs(v.published),
    durationSec: Number(v.durationSec) || 0,
    live: toBool(v.live),
    state,
    rating,
    updatedMs: v.updatedMs || (v.updated ? toMs(v.updated) : 0),
  };
}

export function normalizePages(pages) {
  return (pages || [])
    .map((p, i) => ({
      id: String(p.id),
      name: p.name == null ? '' : String(p.name),
      hint: p.hint == null ? '' : String(p.hint),
      order: Number.isFinite(Number(p.order)) && p.order !== '' ? Number(p.order) : i,
    }))
    .sort((a, b) => a.order - b.order);
}

// Turns a bootstrap reply into the shape every other function here expects.
export function normalize(reply) {
  return {
    pages: normalizePages(reply.pages),
    channels: (reply.channels || []).map(normalizeChannel),
    videos: (reply.videos || []).map(normalizeVideo),
    lastRefresh: reply.lastRefresh || '',
    lastError: reply.lastError || '',
  };
}

// ---- indexes ----

export function pageIdSet(data) {
  return new Set(data.pages.map(p => p.id));
}

export function channelMap(data) {
  return new Map(data.channels.map(c => [c.id, c]));
}

// ---- Other rule ----

// A subscribed channel is in Other when none of its pageIds matches an existing page.
export function isInOther(channel, pageIds) {
  return channel.subscribed && !channel.pageIds.some(id => pageIds.has(id));
}

// A channel is unsorted when it is in no existing page (subscribed or not).
export function isUnsorted(channel, pageIds) {
  return !channel.pageIds.some(id => pageIds.has(id));
}

export function otherChannelIds(data) {
  const ids = pageIdSet(data);
  return new Set(data.channels.filter(c => isInOther(c, ids)).map(c => c.id));
}

export function pageChannelIds(data, pageId) {
  return new Set(data.channels.filter(c => c.pageIds.includes(pageId)).map(c => c.id));
}

// ---- feeds ----

function byNewest(a, b) {
  return (b.publishedMs - a.publishedMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function inWindow(video, now) {
  return video.publishedMs >= now - WINDOW_DAYS * DAY_MS;
}

// Channel IDs for a feed key: a page id, or 'other'.
export function feedChannelIds(data, feedKey) {
  return feedKey === 'other' ? otherChannelIds(data) : pageChannelIds(data, feedKey);
}

// Videos for one feed: unwatched (state null), inside the 30-day window, newest first.
// keepIds: videos that stay even if their state is set (the one open in the player).
export function feedVideos(data, feedKey, { now = Date.now(), keepIds } = {}) {
  const chans = feedChannelIds(data, feedKey);
  return data.videos
    .filter(v => chans.has(v.channelId) && inWindow(v, now) &&
      (v.state === null || (keepIds && keepIds.has(v.id))))
    .sort(byNewest);
}

// Watched page: every watched video, most recently changed first.
export function watchedVideos(data) {
  return data.videos
    .filter(v => v.state === 'watched')
    .sort((a, b) => ((b.updatedMs || b.publishedMs) - (a.updatedMs || a.publishedMs)) || byNewest(a, b));
}

// Items for "Mark page seen": the feed's unwatched videos only. A video open in the
// player that is already watched is left out, so undo (state null) cannot clear it.
export function markPageSeenItems(data, feedKey, opts = {}) {
  return feedVideos(data, feedKey, opts)
    .filter(v => v.state === null)
    .map(v => ({ videoId: v.id, channelId: v.channelId }));
}

// Unwatched counts for the sidebar: {pages: {id: n}, other: n, watched: n, unsorted: n}.
export function counts(data, { now = Date.now() } = {}) {
  const ids = pageIdSet(data);
  const pages = Object.fromEntries(data.pages.map(p => [p.id, 0]));
  const chans = channelMap(data);
  let other = 0, watched = 0;
  for (const v of data.videos) {
    if (v.state === 'watched') watched++;
    if (v.state !== null || !inWindow(v, now)) continue;
    const c = chans.get(v.channelId);
    if (!c) continue;
    for (const pid of new Set(c.pageIds)) if (pid in pages) pages[pid]++;
    if (isInOther(c, ids)) other++;
  }
  const unsorted = data.channels.filter(c => isInOther(c, ids)).length;
  return { pages, other, watched, unsorted };
}

// ---- actions (the same rules the backend applies) ----

function clone(data) {
  return {
    ...data,
    pages: data.pages.map(p => ({ ...p })),
    channels: data.channels.map(c => ({
      ...c, pageIds: [...c.pageIds],
      suggestedPageIds: c.suggestedPageIds === 'none' ? 'none' : [...c.suggestedPageIds],
    })),
    videos: data.videos.map(v => ({ ...v })),
  };
}

// Applies one API action to data and returns new data. Unknown actions change nothing.
// `at` is the time the action was made (for the Watched order).
export function applyAction(data, action, body, at = Date.now()) {
  const d = clone(data);
  switch (action) {
    case 'setState': {
      const state = STATES.has(body.state) ? body.state : null;
      const ids = new Set((body.items || []).map(i => i.videoId));
      for (const v of d.videos) if (ids.has(v.id)) { v.state = state; v.updatedMs = at; }
      return d;
    }
    case 'rate': {
      const rating = RATINGS.has(body.rating) ? body.rating : null;
      for (const v of d.videos) {
        if (v.id !== body.videoId) continue;
        v.rating = rating;
        if (rating) { v.state = 'watched'; v.updatedMs = at; }
      }
      return d;
    }
    case 'savePages': {
      d.pages = normalizePages(body.pages);
      const keep = pageIdSet(d);
      for (const c of d.channels) {
        c.pageIds = c.pageIds.filter(id => keep.has(id));
        if (c.suggestedPageIds !== 'none') c.suggestedPageIds = c.suggestedPageIds.filter(id => keep.has(id));
      }
      return d;
    }
    case 'setChannelPages': {
      const keep = pageIdSet(d);
      for (const c of d.channels) {
        if (c.id === body.channelId) c.pageIds = toList(body.pageIds).filter(id => keep.has(id));
      }
      return d;
    }
    case 'removeChannel': {
      d.channels = d.channels.filter(c => c.id !== body.channelId || c.subscribed);
      const left = new Set(d.channels.map(c => c.id));
      d.videos = d.videos.filter(v => left.has(v.channelId));
      return d;
    }
    default:
      return d;
  }
}

// Applies outbox entries ({action, body, created}) in order on top of a bootstrap.
export function applyPending(data, entries) {
  return (entries || []).reduce((acc, e) => applyAction(acc, e.action, e.body, e.created), data);
}

// Merges channels (and their videos) from an addChannel or suggestPages reply.
export function mergeChannels(data, channels = [], videos = []) {
  const d = clone(data);
  const byId = new Map(d.channels.map((c, i) => [c.id, i]));
  for (const raw of channels) {
    const c = normalizeChannel(raw);
    if (byId.has(c.id)) d.channels[byId.get(c.id)] = c;
    else { byId.set(c.id, d.channels.length); d.channels.push(c); }
  }
  const vIds = new Map(d.videos.map((v, i) => [v.id, i]));
  for (const raw of videos) {
    const v = normalizeVideo(raw);
    if (vIds.has(v.id)) d.videos[vIds.get(v.id)] = { ...v, state: d.videos[vIds.get(v.id)].state };
    else d.videos.push(v);
  }
  return d;
}

// Undo for setState: groups items by their state before the change.
export function undoBatches(data, items) {
  const prev = new Map(data.videos.map(v => [v.id, v.state]));
  const groups = new Map();
  for (const it of items) {
    const s = prev.has(it.videoId) ? prev.get(it.videoId) : null;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(it);
  }
  return [...groups].map(([state, list]) => ({ state, items: list }));
}

// ---- Sort screen ----

// keepIds: channels changed during this visit stay listed, so a second chip can still be clicked.
export function sortList(data, { unsortedOnly = false, query = '', keepIds } = {}) {
  const ids = pageIdSet(data);
  const q = query.trim().toLowerCase();
  return data.channels
    .filter(c => !unsortedOnly || isUnsorted(c, ids) || (keepIds && keepIds.has(c.id)))
    .filter(c => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

// ---- formatting ----

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatAge(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function thumbUrl(videoId) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
}

export function newPageId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}
