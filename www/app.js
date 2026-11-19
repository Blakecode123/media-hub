// media-hub app: state, render, actions, Sort and Settings screens.
import * as L from './logic.js';
import { createHttpApi, createMockApi, Outbox } from './api.js';
import { Player } from './player.js';

const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const DEBUG = params.get('debug') === '1';
const PREFIX = MOCK ? 'mh.mock.' : 'mh.';
const UNDO_MS = 5000;
const POLL_BOOTSTRAP_MS = 15 * 60000;
const log = DEBUG ? (...a) => console.log('[media-hub]', ...a) : () => {};

// ---- storage (every call wrapped: storage can be blocked) ----

const safeStorage = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch (e) { log('storage', e.message); } },
  removeItem(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};
const store = {
  get(k, fallback) {
    try { const v = safeStorage.getItem(PREFIX + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) { safeStorage.setItem(PREFIX + k, JSON.stringify(v)); },
};
const loadSettings = () => { try { return JSON.parse(safeStorage.getItem('mh.settings')) || {}; } catch { return {}; } };
const saveSettings = s => safeStorage.setItem('mh.settings', JSON.stringify(s));

// ---- state ----

const S = {
  api: null,
  outbox: null,
  player: null,
  server: null,   // last bootstrap, with sent actions applied
  view: null,     // server + actions still in the outbox
  route: { screen: 'page', pageId: null },
  playing: null,  // video ID open in the player
  playerError: '',
  keepIds: new Set(),
  loading: false,
  refreshing: false,
  offline: false,
  authError: false,
  lastFetch: 0,
  lastFetchOk: 0,
  sort: { unsortedOnly: true, query: '', busy: false, keepIds: new Set() },
  pagesDraft: null,
  toast: null,
};

// ---- DOM helper ----

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
const $ = id => document.getElementById(id);

// ---- routing ----

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (parts[0]) {
    case 'page': return { screen: 'page', pageId: parts[1] || null };
    case 'other': return { screen: 'other' };
    case 'watched': return { screen: 'watched' };
    case 'sort': return { screen: 'sort' };
    case 'settings': return { screen: 'settings' };
    default: return { screen: 'page', pageId: null };
  }
}

function feedKey() {
  if (S.route.screen === 'other') return 'other';
  if (S.route.screen !== 'page' || !S.view) return null;
  const pages = S.view.pages;
  if (S.route.pageId && pages.some(p => p.id === S.route.pageId)) return S.route.pageId;
  return pages.length ? pages[0].id : 'other';
}

// ---- data ----

function recompute() {
  S.view = S.server ? L.applyPending(S.server, S.outbox ? S.outbox.entries : []) : null;
}

function setServer(d) {
  S.server = d;
  store.set('cache', d);
  recompute();
}

async function loadBootstrap() {
  if (!S.api || S.loading) return;
  S.loading = true;
  renderStatus();
  const seq = S.outbox.ackSeq;
  const t0 = Date.now();
  try {
    const reply = await S.api.call('bootstrap');
    setServer(L.applyPending(L.normalize(reply), S.outbox.ackedSince(seq)));
    S.offline = false;
    S.authError = false;
    S.lastFetchOk = Date.now();
    store.set('cacheAt', S.lastFetchOk);
    log('bootstrap', `${Date.now() - t0} ms`, S.server.channels.length, 'channels', S.server.videos.length, 'videos');
  } catch (e) {
    log('bootstrap failed', e.code, e.message);
    if (e.code === 'auth') S.authError = true;
    else S.offline = true;
  } finally {
    S.loading = false;
    S.lastFetch = Date.now();
    renderData();
  }
}

// Every change goes through here: screen first, then the outbox.
function act(action, body, undo) {
  if (!S.outbox) return;
  if (undo) {
    closeToast();
    const before = S.view;
    const id = S.outbox.add(action, body, { held: true });
    showToast(undo, { entryId: id, body, before });
  } else {
    S.outbox.add(action, body);
  }
}

function undoToast(t) {
  if (S.outbox.remove(t.entryId)) return;
  // Already sent (tab was hidden meanwhile): send the reverse change.
  for (const b of L.undoBatches(t.before, t.body.items)) S.outbox.add('setState', { items: b.items, state: b.state });
}

const item = v => ({ videoId: v.id, channelId: v.channelId });
const findVideo = id => S.view && S.view.videos.find(v => v.id === id);
const channelOf = v => S.view && S.view.channels.find(c => c.id === v.channelId);

function markSeen(v) { act('setState', { items: [item(v)], state: 'seen' }, `Marked seen: ${v.title}`); }
function hide(v) { act('setState', { items: [item(v)], state: 'hidden' }, `Hidden: ${v.title}`); }

function markPageSeen() {
  const key = feedKey();
  const items = L.markPageSeenItems(S.view, key, { keepIds: S.keepIds });
  if (!items.length) return;
  act('setState', { items, state: 'seen' }, `Marked ${items.length} video${items.length === 1 ? '' : 's'} seen`);
}

function rate(v, rating) {
  act('rate', { videoId: v.id, channelId: v.channelId, rating: v.rating === rating ? null : rating });
}

async function refreshNow() {
  if (!S.api || S.refreshing) return;
  S.refreshing = true;
  renderView();
  const seq = S.outbox.ackSeq;
  try {
    await S.outbox.flush();
    const reply = await S.api.call('refreshNow');
    setServer(L.applyPending(L.normalize(reply), S.outbox.ackedSince(seq)));
    S.offline = false;
    showToast('Refreshed.');
  } catch (e) {
    if (e.code === 'busy') {
      showToast('A refresh ran in the last 5 minutes. Loading the latest data instead.');
      S.refreshing = false;
      await loadBootstrap();
    } else {
      showToast(`Refresh failed (${e.code}).`, { error: true });
    }
  } finally {
    S.lastFetch = Date.now();
    S.refreshing = false;
    renderData();
  }
}

// ---- player ----

function play(videoId) {
  const v = findVideo(videoId);
  if (!v || S.playing === videoId) return;
  S.playing = videoId;
  S.playerError = '';
  S.keepIds = new Set([videoId]); // the video before this one may now leave the feed
  $('app').classList.add('playing');
  S.player.open(videoId);
  renderData();
}

function closePlayer() {
  if (!S.playing) return;
  S.player.close();
  S.playing = null;
  S.playerError = '';
  S.keepIds = new Set();
  $('app').classList.remove('playing');
  renderData();
}

function onWatched(videoId) {
  const v = findVideo(videoId);
  if (v && v.state === null) act('setState', { items: [item(v)], state: 'watched' });
}

// ---- outbox wiring ----

function makeOutbox() {
  S.outbox = new Outbox({
    storage: safeStorage,
    storageKey: PREFIX + 'outbox',
    send: (action, body, opts) => S.api.call(action, body, opts),
    log,
    onChange: () => { recompute(); renderData(); },
    onSent: (e, reply) => {
      let d = L.applyAction(S.server, e.action, e.body, e.created);
      if (e.action === 'savePages' && Array.isArray(reply.pages)) d = L.mergeChannels({ ...d, pages: L.normalizePages(reply.pages) }, reply.channels || []);
      if (e.action === 'setChannelPages' && reply.channel) d = L.mergeChannels(d, [reply.channel]);
      setServer(d);
    },
    onFail: (e, err, info) => {
      log('send failed', e.action, err.code, info);
      if (info.blocked) S.authError = true;
      if (info.dropped) {
        showToast(`A change could not be saved (${e.action}: ${err.code}). Reloading data.`, { error: true });
        loadBootstrap();
      }
      if (!S.server) return;
      renderData();
    },
  });
}

function flushNow() {
  if (!S.outbox) return;
  S.outbox.releaseAll();
  S.outbox.flush({ keepalive: true });
}

// ---- toast ----

function showToast(text, { entryId, body, before, error } = {}) {
  closeToast();
  const t = { text, entryId, body, before, timer: null };
  const bar = h('div', { class: 'toast-bar' });
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: 'status' },
    h('span', { class: 'toast-text' }, text),
    entryId ? h('button', { class: 'btn small', onclick: () => { undoToast(t); closeToast(true); } }, 'Undo') : null,
    h('button', { class: 'btn ghost small', 'aria-label': 'Close', onclick: () => closeToast() }, '×'),
    entryId ? bar : null);
  t.el = el;
  $('toasts').replaceChildren(el);
  if (entryId) requestAnimationFrame(() => { bar.style.transitionDuration = `${UNDO_MS}ms`; bar.classList.add('run'); });
  t.timer = setTimeout(() => closeToast(), entryId ? UNDO_MS : 4000);
  S.toast = t;
}

function closeToast(undone = false) {
  const t = S.toast;
  if (!t) return;
  S.toast = null;
  clearTimeout(t.timer);
  t.el.remove();
  if (t.entryId && !undone) S.outbox.release(t.entryId);
}

// ---- render ----

function render() {
  renderSidebar();
  renderBanner();
  renderView();
  renderPanel();
}

// After data changes: leave Settings alone (it holds a draft), refresh the rest.
function renderData() {
  renderSidebar();
  renderBanner();
  if (S.route.screen === 'sort') renderSortList();
  else if (S.route.screen === 'settings') { if (!pagesDirty()) { S.pagesDraft = null; rerenderPages(); } }
  else renderView();
  renderPanel();
}

function renderSidebar() {
  const nav = $('nav');
  const c = S.view ? L.counts(S.view) : null;
  const key = feedKey();
  const link = (href, label, count, active, extra) => h('a', { href, class: `nav-item${active ? ' active' : ''}${extra ? ' ' + extra : ''}` },
    h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'count' }, String(count)) : null);
  const items = [];
  if (S.view) {
    items.push(h('div', { class: 'nav-head' }, 'Pages'));
    for (const p of S.view.pages) items.push(link(`#/page/${encodeURIComponent(p.id)}`, p.name || '(no name)', c.pages[p.id], key === p.id && S.route.screen === 'page'));
    items.push(link('#/other', 'Other', c.other, S.route.screen === 'other' || (key === 'other' && S.route.screen === 'page'), 'other'));
    items.push(link('#/watched', 'Watched', c.watched, S.route.screen === 'watched'));
  }
  items.push(h('div', { class: 'nav-sep' }));
  items.push(link('#/sort', 'Sort channels', c && c.unsorted, S.route.screen === 'sort'));
  items.push(link('#/settings', 'Settings', 0, S.route.screen === 'settings'));
  nav.replaceChildren(...items);
  $('mode-badge').hidden = !MOCK;
  renderStatus();
  const title = !S.view ? null : S.route.screen === 'page' ? (S.view.pages.find(p => p.id === key) || { name: 'Other' }).name
    : { other: 'Other', watched: 'Watched', sort: 'Sort channels', settings: 'Settings' }[S.route.screen];
  document.title = title ? `${title} · media-hub` : 'media-hub';
}

function renderStatus() {
  const el = $('status');
  if (!el) return;
  const parts = [];
  if (S.loading) parts.push('Loading…');
  else if (S.server && S.server.lastRefresh) parts.push(`Feeds updated ${L.formatAge(Date.parse(S.server.lastRefresh))}`);
  if (S.outbox && S.outbox.size) parts.push(`${S.outbox.size} change${S.outbox.size === 1 ? '' : 's'} waiting to send`);
  el.textContent = parts.join(' · ');
}

function renderBanner() {
  const msgs = [];
  if (S.authError) msgs.push(['error', 'The backend refused the key. Check the URL and key in Settings.']);
  if (S.offline) msgs.push(['warn', S.server
    ? `Cannot reach the backend. Showing data saved ${L.formatAge(S.lastFetchOk || 0) || 'earlier'}.`
    : 'Cannot reach the backend. Check the URL in Settings and your connection.']);
  if (S.view && S.view.lastError) msgs.push(['warn', `Last feed refresh had an error: ${S.view.lastError}`]);
  $('banner').replaceChildren(...msgs.map(([kind, text]) => h('div', { class: `banner ${kind}` }, text)));
}

function renderView() {
  const view = $('view');
  if (!S.api && S.route.screen !== 'settings') return view.replaceChildren(setupPrompt());
  switch (S.route.screen) {
    case 'watched': return view.replaceChildren(...watchedScreen());
    case 'sort': return view.replaceChildren(...sortScreen());
    case 'settings': return view.replaceChildren(...settingsScreen());
    default: return view.replaceChildren(...feedScreen());
  }
}

function setupPrompt() {
  return h('div', { class: 'setup' },
    h('h1', null, 'Welcome to media-hub'),
    h('p', null, 'This app shows your YouTube channels sorted into your own pages. It needs your own backend (a Google Apps Script web app) to load data.'),
    h('ol', null,
      h('li', null, 'Set up the backend as the README describes.'),
      h('li', null, 'Open Settings and paste the web-app URL and the key.')),
    h('div', { class: 'row' },
      h('a', { class: 'btn primary', href: '#/settings' }, 'Open Settings'),
      h('a', { class: 'btn', href: '?mock=1' }, 'Try the demo with fake data')));
}

function loadingBlock() {
  return h('div', { class: 'empty' }, S.offline ? 'No saved data yet. Connect to the backend to load your feeds.' : 'Loading your feeds…');
}

function feedScreen() {
  if (!S.view) return [loadingBlock()];
  const key = feedKey();
  const page = S.view.pages.find(p => p.id === key);
  const name = key === 'other' ? 'Other' : page.name;
  const videos = L.feedVideos(S.view, key, { keepIds: S.keepIds });
  const unwatched = videos.filter(v => v.state === null).length;
  const chans = L.channelMap(S.view);
  const header = h('header', { class: 'view-head' },
    h('div', { class: 'title-block' },
      h('h1', null, name),
      h('span', { class: 'sub' }, `${unwatched} new video${unwatched === 1 ? '' : 's'}`,
        key === 'other' ? ' · channels not yet in a page' : '')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: markPageSeen, disabled: !unwatched }, 'Mark page seen'),
      h('button', { class: 'btn', onclick: refreshNow, disabled: S.refreshing, title: 'Ask the backend to fetch new uploads now' },
        S.refreshing ? 'Refreshing…' : 'Refresh'),
      h('span', { class: 'sub' }, S.view.lastRefresh ? `Updated ${L.formatAge(Date.parse(S.view.lastRefresh))}` : '')));
  if (!videos.length) {
    const msg = key === 'other'
      ? 'No new videos from unsorted channels.'
      : (S.view.channels.some(c => c.pageIds.includes(key)) ? 'Nothing new here. You are up to date.' : 'This page has no channels yet. Add some on the Sort screen.');
    return [header, h('div', { class: 'empty' }, msg)];
  }
  return [header, h('div', { class: 'grid' }, videos.map(v => card(v, chans.get(v.channelId), { actions: true })))];
}

function watchedScreen() {
  if (!S.view) return [loadingBlock()];
  const videos = L.watchedVideos(S.view);
  const chans = L.channelMap(S.view);
  const header = h('header', { class: 'view-head' },
    h('div', { class: 'title-block' }, h('h1', null, 'Watched'),
      h('span', { class: 'sub' }, `${videos.length} video${videos.length === 1 ? '' : 's'} from the last ${L.WINDOW_DAYS} days`)));
  if (!videos.length) return [header, h('div', { class: 'empty' }, 'Videos you watch here show up on this page.')];
  return [header, h('div', { class: 'grid' }, videos.map(v => card(v, chans.get(v.channelId), { actions: false })))];
}

function card(v, ch, { actions }) {
  const playingNow = S.playing === v.id;
  const thumbs = v.rating === 'up' ? '👍' : v.rating === 'down' ? '👎' : '';
  return h('article', { class: `card${playingNow ? ' playing' : ''}${v.state === 'watched' ? ' watched' : ''}`, 'data-id': v.id },
    h('button', { class: 'thumb', onclick: () => play(v.id), title: 'Play' },
      h('img', { src: L.thumbUrl(v.id), alt: '', loading: 'lazy' }),
      v.live ? h('span', { class: 'tag live' }, 'LIVE') : null,
      playingNow ? h('span', { class: 'tag now' }, 'Playing') : null,
      v.state === 'watched' && actions ? h('span', { class: 'tag done' }, 'Watched') : null,
      v.durationSec ? h('span', { class: 'dur' }, L.formatDuration(v.durationSec)) : null),
    h('div', { class: 'meta' },
      h('button', { class: 'title', title: v.title, onclick: () => play(v.id) }, v.title),
      h('div', { class: 'sub' }, ch ? ch.title : '', ' · ', L.formatAge(v.publishedMs), thumbs ? ` · ${thumbs}` : '')),
    actions && v.state === null ? h('div', { class: 'card-actions' },
      h('button', { class: 'btn ghost small', onclick: () => markSeen(v), title: 'I saw this elsewhere: remove it' }, 'Seen'),
      h('button', { class: 'btn ghost small', onclick: () => hide(v), title: 'Not interested: remove it' }, 'Hide')) : null);
}

function renderPanel() {
  const head = $('player-head');
  const foot = $('player-foot');
  if (!S.playing) { head.replaceChildren(); foot.replaceChildren(); return; }
  const v = findVideo(S.playing);
  if (!v) return;
  const ch = channelOf(v);
  head.replaceChildren(
    h('div', { class: 'player-title' },
      h('h2', null, v.title),
      h('div', { class: 'sub' }, ch ? ch.title : '', ' · ', L.formatAge(v.publishedMs),
        v.state === 'watched' ? ' · watched' : '')),
    h('button', { class: 'btn ghost', onclick: closePlayer, title: 'Close the player (Esc)', 'aria-label': 'Close player' }, '✕ Close'));
  foot.replaceChildren(h('div', null,
    h('div', { class: 'row' },
      h('button', { class: `btn thumb-btn${v.rating === 'up' ? ' on' : ''}`, onclick: () => rate(v, 'up'), title: 'Thumbs up (also marks watched)' }, '👍 Up'),
      h('button', { class: `btn thumb-btn${v.rating === 'down' ? ' on' : ''}`, onclick: () => rate(v, 'down'), title: 'Thumbs down (also marks watched)' }, '👎 Down'),
      h('a', { class: 'btn ghost', href: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`, target: '_blank', rel: 'noopener' }, 'Open on YouTube')),
    S.playerError ? h('div', { class: 'banner warn' }, S.playerError) : null));
}

// ---- Sort screen ----

function sortScreen() {
  const head = h('header', { class: 'view-head' },
    h('div', { class: 'title-block' }, h('h1', null, 'Sort channels'),
      h('span', { class: 'sub' }, 'Click a page chip to put a channel in that page or take it out. Dashed chips are AI suggestions: one click accepts.')));
  if (!S.view) return [head, loadingBlock()];
  const controls = h('div', { class: 'sort-controls' },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: S.sort.unsortedOnly, onchange: e => { S.sort.unsortedOnly = e.target.checked; S.sort.keepIds = new Set(); renderSortList(); } }),
      ' Unsorted only'),
    h('input', { type: 'search', class: 'input', placeholder: 'Find a channel', value: S.sort.query,
      oninput: e => { S.sort.query = e.target.value; renderSortList(); } }),
    h('button', { class: 'btn', id: 'suggest-btn', onclick: suggestAI, disabled: S.sort.busy || !S.view.pages.length,
      title: 'Ask Gemini to suggest pages for the channels in the list' }, S.sort.busy ? 'Asking AI…' : 'Suggest with AI'));
  const add = h('form', { class: 'add-channel', onsubmit: addChannel },
    h('input', { class: 'input', name: 'link', placeholder: 'Add a channel by link: @handle, channel URL or video URL', required: true }),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add channel'));
  return [head, controls, add, h('div', { id: 'sort-list', class: 'sort-list' }, sortRows())];
}

function renderSortList() {
  const el = $('sort-list');
  if (el) el.replaceChildren(...sortRows());
  else renderView();
  const btn = $('suggest-btn');
  if (btn) { btn.disabled = S.sort.busy || !(S.view && S.view.pages.length); btn.textContent = S.sort.busy ? 'Asking AI…' : 'Suggest with AI'; }
}

function sortRows() {
  if (!S.view) return [loadingBlock()];
  if (!S.view.pages.length) return [h('div', { class: 'empty' }, 'Make your pages in Settings first. Then sort channels into them here.')];
  const list = L.sortList(S.view, S.sort);
  if (!list.length) return [h('div', { class: 'empty' }, S.sort.unsortedOnly ? 'Every channel is in a page.' : 'No channels match.')];
  const pids = L.pageIdSet(S.view);
  return list.map(c => {
    const sugg = Array.isArray(c.suggestedPageIds) ? c.suggestedPageIds.filter(id => pids.has(id)) : [];
    const chips = S.view.pages.map(p => {
      const on = c.pageIds.includes(p.id);
      const isSugg = !on && sugg.includes(p.id);
      return h('button', { class: `chip${on ? ' on' : ''}${isSugg ? ' sugg' : ''}`, title: on ? 'In this page: click to take out' : isSugg ? 'AI suggestion: click to accept' : 'Click to add to this page',
        onclick: () => togglePage(c, p.id) }, isSugg ? `✦ ${p.name}` : p.name);
    });
    const tags = [];
    if (!c.subscribed) tags.push(h('span', { class: 'tag-inline' }, c.addedByLink ? 'added by link' : 'not subscribed'));
    if (c.suggestedPageIds === 'none') tags.push(h('span', { class: 'tag-inline muted' }, 'AI: no page fits'));
    const nVideos = S.view.videos.filter(v => v.channelId === c.id && v.state === null).length;
    return h('div', { class: 'sort-row' },
      avatar(c),
      h('div', { class: 'sort-main' },
        h('div', { class: 'sort-title' }, h('strong', null, c.title || c.id), ...tags,
          h('span', { class: 'sub' }, `${nVideos} new`)),
        c.description ? h('div', { class: 'sub clamp1', title: c.description }, c.description) : null,
        h('div', { class: 'chips' }, chips)),
      !c.subscribed ? h('button', { class: 'btn ghost small', title: 'Remove this linked channel', onclick: () => removeChannel(c) }, 'Remove') : null);
  });
}

function avatar(c) {
  if (c.thumb) return h('img', { class: 'avatar', src: c.thumb, alt: '', loading: 'lazy' });
  const letters = (c.title || '?').split(/\s+/).filter(w => /\w/.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return h('div', { class: 'avatar' }, letters || '?');
}

function togglePage(c, pageId) {
  S.sort.keepIds.add(c.id);
  const pageIds = c.pageIds.includes(pageId) ? c.pageIds.filter(id => id !== pageId) : [...c.pageIds, pageId];
  act('setChannelPages', { channelId: c.id, pageIds });
}

function removeChannel(c) {
  if (!confirm(`Remove "${c.title}"? Its videos leave every page.`)) return;
  act('removeChannel', { channelId: c.id });
}

async function suggestAI() {
  if (!S.api || S.sort.busy) return;
  const channelIds = L.sortList(S.view, S.sort).map(c => c.id).slice(0, 50);
  if (!channelIds.length) return;
  S.sort.busy = true;
  renderSortList();
  try {
    const reply = await S.api.call('suggestPages', { channelIds });
    setServer(L.mergeChannels(S.server, reply.channels || []));
    const n = (reply.channels || []).length;
    showToast(n ? `AI looked at ${n} channel${n === 1 ? '' : 's'}.` : 'AI had nothing to suggest.');
  } catch (e) {
    showToast(`AI suggestions failed (${e.code}).`, { error: true });
  } finally {
    S.sort.busy = false;
    renderData();
  }
}

async function addChannel(e) {
  e.preventDefault();
  const form = e.target;
  const link = form.link.value.trim();
  if (!link || !S.api) return;
  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const reply = await S.api.call('addChannel', { link });
    setServer(L.mergeChannels(S.server, [reply.channel], reply.videos || []));
    form.reset();
    S.sort.query = '';
    showToast(`Added ${reply.channel.title}. Now pick its pages.`);
    renderView();
  } catch (err) {
    showToast(err.code === 'bad_link' ? 'That link was not understood. Use @handle, a channel URL or a video URL.' : `Could not add the channel (${err.code}).`, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add channel';
  }
}

// ---- Settings screen ----

function settingsScreen() {
  const st = loadSettings();
  if (S.view && !S.pagesDraft) S.pagesDraft = S.view.pages.map(p => ({ ...p }));
  const backend = h('section', { class: 'panel' },
    h('h2', null, 'Backend'),
    MOCK ? h('p', { class: 'banner warn' }, 'Demo mode (?mock=1): fake data, kept in memory only. Changes here do not reach a backend.') : null,
    h('form', { class: 'form', onsubmit: saveBackend },
      h('label', null, 'Web-app URL', h('input', { class: 'input', name: 'url', type: 'url', value: st.url || '', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off' })),
      h('label', null, 'Key', h('input', { class: 'input', name: 'key', type: 'password', value: st.key || '', autocomplete: 'off', spellcheck: 'false' })),
      h('p', { class: 'sub' }, 'Both stay in this browser only (localStorage).'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save and connect'))));
  const credits = h('section', { class: 'panel' },
    h('h2', null, 'Credits'),
    h('p', null, 'Videos play in the official YouTube embedded player. This app uses YouTube API Services. See the ',
      h('a', { href: 'https://www.youtube.com/t/terms', target: '_blank', rel: 'noopener' }, 'YouTube Terms of Service'), ' and the ',
      h('a', { href: 'https://policies.google.com/privacy', target: '_blank', rel: 'noopener' }, 'Google Privacy Policy'), '.'),
    h('p', { class: 'sub' }, 'Page suggestions come from Google Gemini. Only channel names, descriptions and video titles are sent.'),
    h('p', { class: 'sub' }, 'Add ?debug=1 to the address to log API calls and player events to the browser console.'));
  return [h('header', { class: 'view-head' }, h('div', { class: 'title-block' }, h('h1', null, 'Settings'))),
    backend, pagesPanel(), credits];
}

function pagesPanel() {
  const panel = h('section', { class: 'panel', id: 'pages-panel' }, h('h2', null, 'Pages'));
  if (!S.api || !S.view || !S.pagesDraft) {
    panel.append(h('p', { class: 'sub' }, 'Connect the backend to edit your pages.'));
    return panel;
  }
  const d = S.pagesDraft;
  const dirty = pagesDirty();
  const rows = d.map((p, i) => h('div', { class: 'page-row' },
    h('div', { class: 'row tight' },
      h('button', { class: 'btn ghost small', disabled: i === 0, title: 'Move up', onclick: () => movePage(i, -1) }, '▲'),
      h('button', { class: 'btn ghost small', disabled: i === d.length - 1, title: 'Move down', onclick: () => movePage(i, 1) }, '▼')),
    h('input', { class: 'input', value: p.name, placeholder: 'Page name', 'aria-label': 'Page name', oninput: e => { p.name = e.target.value; markDirty(); } }),
    h('input', { class: 'input', value: p.hint, placeholder: 'Hint for AI sorting (optional)', 'aria-label': 'Hint', oninput: e => { p.hint = e.target.value; markDirty(); } }),
    h('button', { class: 'btn ghost small danger', title: 'Delete page', onclick: () => deletePage(i) }, 'Delete')));
  panel.append(
    h('p', { class: 'sub' }, 'Rename, reorder or delete pages. A deleted page frees its channels: subscribed ones go back to Other.'),
    h('div', { class: 'page-rows' }, rows),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: addPage }, '+ Add page'),
      h('button', { class: 'btn primary', id: 'save-pages', disabled: !dirty, onclick: savePages }, 'Save pages'),
      dirty ? h('button', { class: 'btn ghost', onclick: () => { S.pagesDraft = null; rerenderPages(); } }, 'Discard changes') : null,
      h('span', { class: 'sub', id: 'pages-dirty' }, dirty ? 'Unsaved changes' : '')));
  return panel;
}

function pagesDirty() {
  if (!S.pagesDraft || !S.view) return false;
  const key = list => JSON.stringify(list.map(p => [p.id, p.name, p.hint]));
  return key(S.pagesDraft) !== key(S.view.pages);
}

function rerenderPages() {
  if (S.view && !S.pagesDraft) S.pagesDraft = S.view.pages.map(p => ({ ...p }));
  const old = $('pages-panel');
  if (old) old.replaceWith(pagesPanel());
}

function markDirty() {
  const btn = $('save-pages');
  if (btn) btn.disabled = false;
  const note = $('pages-dirty');
  if (note) note.textContent = 'Unsaved changes';
}

function movePage(i, dir) {
  const d = S.pagesDraft;
  [d[i], d[i + dir]] = [d[i + dir], d[i]];
  rerenderPages();
}

function addPage() {
  S.pagesDraft.push({ id: L.newPageId(), name: '', hint: '', order: S.pagesDraft.length });
  rerenderPages();
  const inputs = document.querySelectorAll('#pages-panel .page-row input[aria-label="Page name"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function deletePage(i) {
  const p = S.pagesDraft[i];
  const n = S.view.channels.filter(c => c.pageIds.includes(p.id)).length;
  if (n && !confirm(`Delete page "${p.name}"? Its ${n} channel${n === 1 ? '' : 's'} leave this page.`)) return;
  S.pagesDraft.splice(i, 1);
  rerenderPages();
}

function savePages() {
  const pages = S.pagesDraft.map((p, i) => ({ id: p.id, name: p.name.trim() || 'Untitled', hint: p.hint.trim(), order: i }));
  act('savePages', { pages });
  S.pagesDraft = null;
  rerenderPages();
  showToast('Pages saved.');
}

function saveBackend(e) {
  e.preventDefault();
  const url = e.target.url.value.trim();
  const key = e.target.key.value.trim();
  saveSettings({ url, key });
  if (MOCK) { showToast('Saved. Remove ?mock=1 from the address to use the backend.'); return; }
  if (!url || !key) { showToast('Enter both the URL and the key.', { error: true }); return; }
  S.api = createHttpApi({ url, key, log });
  if (!S.outbox) { makeOutbox(); startPolling(); }
  S.authError = false;
  S.outbox.unblock();
  S.pagesDraft = null;
  showToast('Saved. Connecting…');
  loadBootstrap().then(() => { if (S.route.screen === 'settings') rerenderPages(); });
}

// ---- start ----

function onRoute() {
  S.route = parseRoute();
  if (S.route.screen !== 'settings') S.pagesDraft = null;
  S.sort.keepIds = new Set();
  render();
  $('main').scrollTop = 0;
}

let pollTimer = null;
function startPolling() {
  if (!pollTimer) pollTimer = setInterval(() => { if (document.visibilityState === 'visible') loadBootstrap(); }, POLL_BOOTSTRAP_MS);
}

async function init() {
  S.player = new Player({
    mount: $('player-box'),
    log,
    onWatched,
    onError: (id, msg) => { if (id === S.playing) { S.playerError = msg; renderPanel(); } },
  });
  S.route = parseRoute();
  window.addEventListener('hashchange', onRoute);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && S.playing && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) closePlayer();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
    else if (S.api && Date.now() - S.lastFetch > 10 * 60000) loadBootstrap();
  });
  window.addEventListener('pagehide', flushNow);
  setInterval(renderStatus, 60000);
  if (DEBUG) window.mh = { S, L, play, closePlayer, loadBootstrap };

  const st = loadSettings();
  if (MOCK) {
    try {
      const seed = await fetch('mock/bootstrap.json').then(r => r.json());
      S.api = createMockApi(seed, { log, failRate: Number(params.get('mockfail')) || 0 });
    } catch (e) {
      log('mock load failed', e);
    }
  } else if (st.url && st.key) {
    S.api = createHttpApi({ url: st.url, key: st.key, log });
  }
  if (!S.api) { render(); return; }

  makeOutbox();
  // The mock backend starts fresh on each load, so its old cache would only flash stale data.
  const cached = MOCK ? null : store.get('cache', null);
  if (cached) {
    try { S.server = L.normalize(cached); S.lastFetchOk = store.get('cacheAt', 0); recompute(); } catch (e) { log('cache unreadable', e); }
  }
  render();
  await S.outbox.flush();
  await loadBootstrap();
  startPolling();
}

init();
