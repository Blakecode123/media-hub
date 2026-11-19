// Frontend tests: run with `node --test` (Node 20+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../www/logic.js';
import { Outbox, createMockApi, ApiError, MAX_TRIES, isPermanentError } from '../www/api.js';

const NOW = Date.parse('2026-11-19T00:00:00Z');
const H = 3600000;
const iso = ms => new Date(ms).toISOString();
const seed = JSON.parse(readFileSync(new URL('../www/mock/bootstrap.json', import.meta.url), 'utf8'));

function fixture() {
  return L.normalize({
    pages: [
      { id: 'a', name: 'A', order: 1 },
      { id: 'b', name: 'B', order: 0 },
    ],
    channels: [
      { id: 'c1', title: 'One', subscribed: true, pageIds: 'a' },              // comma-list form
      { id: 'c2', title: 'Two', subscribed: 'true', pageIds: ['a', 'b'] },     // two pages
      { id: 'c3', title: 'Three', subscribed: true, pageIds: [] },             // Other
      { id: 'c4', title: 'Four', subscribed: true, pageIds: ['gone'] },        // deleted page -> Other
      { id: 'c5', title: 'Five', subscribed: false, addedByLink: true, pageIds: ['gone'] }, // nowhere
      { id: 'c6', title: 'Six', subscribed: false, addedByLink: true, pageIds: 'b', suggestedPageIds: 'none' },
    ],
    videos: [
      { id: 'v1', channelId: 'c1', title: '=SUM(1)', published: iso(NOW - 1 * H), durationSec: '61', state: '', rating: '' },
      { id: 'v2', channelId: 'c1', title: 'old', published: iso(NOW - 31 * 24 * H), durationSec: 10 },
      { id: 'v3', channelId: 'c2', title: 'both pages', published: iso(NOW - 2 * H), durationSec: 10 },
      { id: 'v4', channelId: 'c2', title: 'watched', published: iso(NOW - 3 * H), durationSec: 10, state: 'watched', rating: 'up', updated: iso(NOW - 10 * H) },
      { id: 'v5', channelId: 'c3', title: 'other', published: iso(NOW - 4 * H), durationSec: 10 },
      { id: 'v6', channelId: 'c4', title: 'deleted page', published: iso(NOW - 5 * H), durationSec: 10 },
      { id: 'v7', channelId: 'c5', title: 'nowhere', published: iso(NOW - 6 * H), durationSec: 10 },
      { id: 'v8', channelId: 'c6', title: 'linked', published: iso(NOW - 7 * H), durationSec: 10, state: 'seen' },
      { id: 'v9', channelId: 'c6', title: 'watched later', published: iso(NOW - 30 * H), durationSec: 10, state: 'watched', updated: iso(NOW - 1 * H) },
      { id: 'v10', channelId: 'c3', title: 'hidden', published: iso(NOW - 8 * H), durationSec: 10, state: 'hidden' },
    ],
    lastRefresh: iso(NOW - H),
    lastError: '',
  });
}
const ids = list => list.map(v => v.id);

test('normalize: comma lists, booleans, empty state and rating, page order', () => {
  const d = fixture();
  assert.deepEqual(d.pages.map(p => p.id), ['b', 'a']);
  assert.deepEqual(d.channels[0].pageIds, ['a']);
  assert.equal(d.channels[1].subscribed, true);
  assert.equal(d.channels[5].suggestedPageIds, 'none');
  assert.equal(d.videos[0].state, null);
  assert.equal(d.videos[0].rating, null);
  assert.equal(d.videos[0].durationSec, 61);
  assert.equal(d.videos[0].title, '=SUM(1)');
});

test('feed per page: own channels only, unwatched, 30-day window, newest first', () => {
  const d = fixture();
  assert.deepEqual(ids(L.feedVideos(d, 'a', { now: NOW })), ['v1', 'v3']);
  assert.deepEqual(ids(L.feedVideos(d, 'b', { now: NOW })), ['v3']); // v8 is seen
  assert.deepEqual(ids(L.feedVideos(d, 'nope', { now: NOW })), []);
});

test('Other rule: no existing page and subscribed; a deleted page counts as none', () => {
  const d = fixture();
  assert.deepEqual([...L.otherChannelIds(d)].sort(), ['c3', 'c4']);
  assert.deepEqual(ids(L.feedVideos(d, 'other', { now: NOW })), ['v5', 'v6']);
  // Deleting page b moves nothing to Other except subscribed channels left with no page.
  const d2 = L.applyAction(d, 'savePages', { pages: [{ id: 'a', name: 'A', order: 0 }] });
  assert.deepEqual([...L.otherChannelIds(d2)].sort(), ['c3', 'c4']);
  // Deleting page a: c1 (only in a) moves to Other; c2 keeps b... b is gone too here.
  const d3 = L.applyAction(d, 'savePages', { pages: [{ id: 'b', name: 'B', order: 0 }] });
  assert.deepEqual([...L.otherChannelIds(d3)].sort(), ['c1', 'c3', 'c4']);
  assert.deepEqual(d3.channels.find(c => c.id === 'c2').pageIds, ['b']);
  // An unsubscribed channel with a deleted page is unsorted but not in Other.
  assert.equal(L.isUnsorted(d.channels[4], L.pageIdSet(d)), true);
  assert.equal(L.isInOther(d.channels[4], L.pageIdSet(d)), false);
});

test('Watched page: watched videos only, most recently marked first', () => {
  assert.deepEqual(ids(L.watchedVideos(fixture())), ['v9', 'v4']);
});

test('keepIds: a video watched while open stays in the feed until the player closes', () => {
  const d = L.applyAction(fixture(), 'setState', { items: [{ videoId: 'v1', channelId: 'c1' }], state: 'watched' });
  assert.deepEqual(ids(L.feedVideos(d, 'a', { now: NOW, keepIds: new Set(['v1']) })), ['v1', 'v3']);
  assert.deepEqual(ids(L.feedVideos(d, 'a', { now: NOW })), ['v3']);
});

test('counts: per page, Other, Watched, unsorted channels', () => {
  const c = L.counts(fixture(), { now: NOW });
  assert.deepEqual(c.pages, { b: 1, a: 2 });
  assert.equal(c.other, 2);
  assert.equal(c.watched, 2);
  assert.equal(c.unsorted, 2);
});

test('mark page seen list: unwatched feed items, also on Other; skips a kept watched video', () => {
  const d = fixture();
  assert.deepEqual(L.markPageSeenItems(d, 'a', { now: NOW }),
    [{ videoId: 'v1', channelId: 'c1' }, { videoId: 'v3', channelId: 'c2' }]);
  assert.deepEqual(L.markPageSeenItems(d, 'other', { now: NOW }),
    [{ videoId: 'v5', channelId: 'c3' }, { videoId: 'v6', channelId: 'c4' }]);
  const w = L.applyAction(d, 'setState', { items: [{ videoId: 'v1', channelId: 'c1' }], state: 'watched' });
  assert.deepEqual(L.markPageSeenItems(w, 'a', { now: NOW, keepIds: new Set(['v1']) }),
    [{ videoId: 'v3', channelId: 'c2' }]);
});

test('applyAction: rate sets watched; null rating keeps state; setChannelPages drops unknown pages', () => {
  let d = L.applyAction(fixture(), 'rate', { videoId: 'v5', channelId: 'c3', rating: 'down' }, NOW);
  let v = d.videos.find(x => x.id === 'v5');
  assert.equal(v.rating, 'down');
  assert.equal(v.state, 'watched');
  assert.equal(v.updatedMs, NOW);
  d = L.applyAction(d, 'rate', { videoId: 'v5', channelId: 'c3', rating: null });
  v = d.videos.find(x => x.id === 'v5');
  assert.equal(v.rating, null);
  assert.equal(v.state, 'watched');
  d = L.applyAction(d, 'setChannelPages', { channelId: 'c3', pageIds: ['a', 'zzz'] });
  assert.deepEqual(d.channels.find(c => c.id === 'c3').pageIds, ['a']);
});

test('applyAction: removeChannel removes only unsubscribed channels and their videos', () => {
  let d = L.applyAction(fixture(), 'removeChannel', { channelId: 'c3' });
  assert.ok(d.channels.some(c => c.id === 'c3'));
  d = L.applyAction(d, 'removeChannel', { channelId: 'c5' });
  assert.ok(!d.channels.some(c => c.id === 'c5'));
  assert.ok(!d.videos.some(v => v.id === 'v7'));
});

test('applyAction does not change its input', () => {
  const d = fixture();
  const before = JSON.stringify(d);
  L.applyAction(d, 'setState', { items: [{ videoId: 'v1' }], state: 'seen' });
  L.applyAction(d, 'savePages', { pages: [] });
  assert.equal(JSON.stringify(d), before);
});

test('outbox apply on top of bootstrap: pending actions in order, undo cancels', () => {
  const boot = fixture();
  const pending = [
    { action: 'setState', body: { items: [{ videoId: 'v1', channelId: 'c1' }, { videoId: 'v3', channelId: 'c2' }], state: 'seen' }, created: NOW },
    { action: 'setState', body: { items: [{ videoId: 'v3', channelId: 'c2' }], state: null }, created: NOW + 1 },
    { action: 'rate', body: { videoId: 'v5', channelId: 'c3', rating: 'up' }, created: NOW + 2 },
    { action: 'setChannelPages', body: { channelId: 'c4', pageIds: ['b'] }, created: NOW + 3 },
  ];
  const view = L.applyPending(boot, pending);
  assert.deepEqual(ids(L.feedVideos(view, 'a', { now: NOW })), ['v3']);
  assert.deepEqual(ids(L.feedVideos(view, 'other', { now: NOW })), []);
  assert.deepEqual(ids(L.feedVideos(view, 'b', { now: NOW })), ['v3', 'v6']);
  assert.deepEqual(ids(L.watchedVideos(view)), ['v5', 'v9', 'v4']);
  assert.deepEqual(L.applyPending(boot, []), boot);
});

test('undoBatches groups items by their earlier state', () => {
  const d = fixture();
  const items = [{ videoId: 'v1' }, { videoId: 'v4' }, { videoId: 'v3' }];
  assert.deepEqual(L.undoBatches(d, items), [
    { state: null, items: [{ videoId: 'v1' }, { videoId: 'v3' }] },
    { state: 'watched', items: [{ videoId: 'v4' }] },
  ]);
});

test('sortList: unsorted filter, text search, alphabetical', () => {
  const d = fixture();
  assert.deepEqual(L.sortList(d, { unsortedOnly: true }).map(c => c.id), ['c5', 'c4', 'c3']);
  assert.deepEqual(L.sortList(d, { query: 'tw' }).map(c => c.id), ['c2']);
  const placed = L.applyAction(d, 'setChannelPages', { channelId: 'c3', pageIds: ['a'] });
  assert.deepEqual(L.sortList(placed, { unsortedOnly: true }).map(c => c.id), ['c5', 'c4']);
  assert.deepEqual(L.sortList(placed, { unsortedOnly: true, keepIds: new Set(['c3']) }).map(c => c.id), ['c5', 'c4', 'c3']);
});

test('formatting: durations and ages', () => {
  assert.equal(L.formatDuration(19), '0:19');
  assert.equal(L.formatDuration(754), '12:34');
  assert.equal(L.formatDuration(9120), '2:32:00');
  assert.equal(L.formatAge(NOW - 30000, NOW), 'just now');
  assert.equal(L.formatAge(NOW - 5 * 60000, NOW), '5 min ago');
  assert.equal(L.formatAge(NOW - 3 * H, NOW), '3 h ago');
  assert.equal(L.formatAge(NOW - 49 * H, NOW), '2 days ago');
});

// ---- outbox ----

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

function makeOutbox(sendImpl, storage = memStorage()) {
  const sent = [], fails = [], timers = [];
  const ob = new Outbox({
    storage,
    send: async (action, body) => { sent.push(action); return sendImpl(action, body); },
    onSent: e => sent.push(`ack:${e.action}`),
    onFail: (e, err, info) => fails.push({ code: err.code, ...info }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { ob, sent, fails, timers, storage };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('outbox: a held entry waits; undo removes it unsent; release sends in order', async () => {
  const { ob, sent } = makeOutbox(async () => ({ ok: true }));
  const a = ob.add('setState', { items: [], state: 'seen' }, { held: true });
  ob.add('rate', { videoId: 'x', rating: 'up' });
  await tick();
  assert.deepEqual(sent, []); // the queue stops at the held entry
  assert.equal(ob.remove(a), true);
  await tick();
  assert.deepEqual(sent, ['rate', 'ack:rate']);
  const b = ob.add('setState', { items: [], state: 'hidden' }, { held: true });
  ob.release(b);
  await tick();
  assert.deepEqual(sent, ['rate', 'ack:rate', 'setState', 'ack:setState']);
  assert.equal(ob.size, 0);
  assert.equal(ob.remove(b), false); // already sent: the caller must send a reverse action
  assert.equal(ob.ackedSince(0).length, 2);
  assert.equal(ob.ackedSince(1).length, 1);
});

test('outbox: network errors keep the entry and schedule a retry; it survives a reload', async () => {
  let fail = true;
  const { ob, fails, timers, storage } = makeOutbox(async () => {
    if (fail) throw new ApiError('network');
    return { ok: true };
  });
  ob.add('setState', { items: [{ videoId: 'v' }], state: 'seen' });
  await tick();
  assert.equal(ob.size, 1);
  assert.equal(fails[0].retry, true);
  assert.equal(timers.length, 1);
  // A new page load reads the same storage and holds nothing.
  const again = makeOutbox(async () => ({ ok: true }), storage);
  assert.equal(again.ob.size, 1);
  assert.equal(again.ob.entries[0].held, false);
  fail = false;
  timers[0].fn();
  await tick();
  assert.equal(ob.size, 0);
});

test('outbox: auth error blocks the queue until unblock', async () => {
  let code = 'auth';
  const { ob, fails } = makeOutbox(async () => { if (code) throw new ApiError(code); return { ok: true }; });
  ob.add('rate', { videoId: 'x', rating: 'up' });
  await tick();
  assert.equal(ob.blocked, true);
  assert.equal(fails[0].blocked, true);
  code = null;
  ob.unblock();
  await tick();
  assert.equal(ob.size, 0);
});

test('outbox: a server error is retried MAX_TRIES times, then dropped', async () => {
  const { ob, fails, timers } = makeOutbox(async () => { throw new ApiError('server'); });
  ob.add('removeChannel', { channelId: 'c' });
  for (let i = 0; i < MAX_TRIES + 1 && ob.size; i++) {
    await tick();
    const t = timers.shift();
    if (t) t.fn();
  }
  await tick();
  assert.equal(ob.size, 0);
  assert.equal(fails.filter(f => f.retry).length, MAX_TRIES - 1);
  assert.equal(fails.at(-1).dropped, true);
});

test('outbox: an error a retry cannot fix is dropped at once', async () => {
  for (const code of ['bad_state', 'bad_page_name', 'not_found', 'subscribed']) {
    const { ob, fails, timers } = makeOutbox(async () => { throw new ApiError(code); });
    ob.add('setState', { items: [{ videoId: 'v', channelId: 'c' }], state: 'seen' });
    await tick();
    assert.equal(ob.size, 0, code);
    assert.equal(timers.length, 0, code);
    assert.equal(fails[0].dropped, true, code);
  }
  assert.equal(isPermanentError('server'), false);
  assert.equal(isPermanentError('busy'), false);
});

// ---- mock backend: must match Session A's reply shapes (shared note api-shapes-backend.md) ----

const CHANNEL_KEYS = ['addedByLink', 'description', 'hasLive', 'id', 'pageIds', 'subscribed', 'suggestedPageIds', 'thumb', 'title'];
const VIDEO_KEYS = ['channelId', 'durationSec', 'id', 'live', 'published', 'rating', 'state', 'title'];
const PAGE_KEYS = ['hint', 'id', 'name', 'order'];

function checkChannel(c) {
  assert.deepEqual(Object.keys(c).sort(), CHANNEL_KEYS, c.id);
  assert.equal(typeof c.subscribed, 'boolean');
  assert.equal(typeof c.addedByLink, 'boolean');
  assert.ok(Array.isArray(c.pageIds));
  assert.ok(Array.isArray(c.suggestedPageIds) || c.suggestedPageIds === 'none');
  assert.ok(['yes', 'no', 'unknown'].includes(c.hasLive));
}
function checkVideo(v) {
  assert.deepEqual(Object.keys(v).sort(), VIDEO_KEYS, v.id);
  assert.equal(typeof v.durationSec, 'number');
  assert.equal(typeof v.live, 'boolean');
  assert.ok(v.state === null || ['watched', 'seen', 'hidden'].includes(v.state));
  assert.ok(v.rating === null || ['up', 'down'].includes(v.rating));
  assert.ok(!Number.isNaN(Date.parse(v.published)) && v.published.endsWith('Z'));
}
function checkBootstrap(b) {
  assert.deepEqual(Object.keys(b).sort(), ['channels', 'lastError', 'lastRefresh', 'ok', 'pages', 'videos']);
  b.pages.forEach((p, i) => { assert.deepEqual(Object.keys(p).sort(), PAGE_KEYS); assert.equal(p.order, i); });
  const pids = new Set(b.pages.map(p => p.id));
  for (const c of b.channels) {
    checkChannel(c);
    assert.ok(c.pageIds.every(id => pids.has(id)), 'pageIds hold only existing pages');
  }
  b.videos.forEach(checkVideo);
  for (let i = 1; i < b.videos.length; i++) assert.ok(b.videos[i - 1].published >= b.videos[i].published, 'newest first');
  assert.equal(typeof b.lastRefresh, 'string');
  assert.equal(typeof b.lastError, 'string');
}

test('mock backend: replies match the backend shapes and error codes', async () => {
  let now = NOW + 5 * 24 * H;
  const api = createMockApi(seed, { now: () => now, latencyMs: 0 });
  const boot = await api.call('bootstrap');
  checkBootstrap(boot);
  // Dates move so the newest seed video stays recent.
  assert.ok(now - Date.parse(boot.videos[0].published) < 24 * H);

  const v = boot.videos.find(x => x.state === null);
  const it = [{ videoId: v.id, channelId: v.channelId }];
  assert.deepEqual(await api.call('setState', { items: it, state: 'seen' }), { ok: true, count: 1 });
  await assert.rejects(api.call('setState', { items: it, state: 'gone' }), e => e.code === 'bad_state');
  await assert.rejects(api.call('setState', { items: [], state: 'seen' }), e => e.code === 'bad_request');
  assert.deepEqual(await api.call('rate', { videoId: v.id, channelId: v.channelId, rating: 'up' }), { ok: true });
  assert.equal(api.db.videos.find(x => x.id === v.id).state, 'watched');
  await api.call('rate', { videoId: v.id, channelId: v.channelId, rating: null });
  assert.equal(api.db.videos.find(x => x.id === v.id).state, 'watched'); // null keeps the state

  const saved = await api.call('savePages', { pages: [...boot.pages.slice(1), { name: 'New one' }] });
  assert.deepEqual(Object.keys(saved).sort(), ['channels', 'ok', 'pages']);
  assert.equal(saved.pages.length, boot.pages.length);
  assert.ok(saved.pages.at(-1).id, 'the server makes a missing ID');
  saved.channels.forEach(checkChannel);
  assert.ok(saved.channels.length > 0, 'channels of the deleted page come back');
  assert.ok(!saved.channels.some(c => c.pageIds.includes(boot.pages[0].id)));
  await assert.rejects(api.call('savePages', { pages: [{ id: 'x', name: '  ' }] }), e => e.code === 'bad_page_name');
  await assert.rejects(api.call('savePages', { pages: [{ id: 'none', name: 'A' }] }), e => e.code === 'bad_page_id');
  await assert.rejects(api.call('savePages', { pages: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }), e => e.code === 'bad_page_id');

  const pages = saved.pages;
  const ch = (await api.call('setChannelPages', { channelId: boot.channels[0].id, pageIds: [pages[0].id, 'bad', pages[0].id] })).channel;
  checkChannel(ch);
  assert.deepEqual(ch.pageIds, [pages[0].id]);
  await assert.rejects(api.call('setChannelPages', { channelId: 'nope', pageIds: [] }), e => e.code === 'not_found');

  const added = await api.call('addChannel', { link: 'https://www.youtube.com/@some-new-channel' });
  checkChannel(added.channel);
  added.videos.forEach(checkVideo);
  assert.equal(added.channel.addedByLink, true);
  assert.ok(added.videos.length > 0);
  await assert.rejects(api.call('addChannel', { link: 'not a link' }), e => e.code === 'bad_link');

  const sub = boot.channels.find(c => c.subscribed);
  await assert.rejects(api.call('removeChannel', { channelId: sub.id }), e => e.code === 'subscribed');
  assert.deepEqual(await api.call('removeChannel', { channelId: added.channel.id }), { ok: true });

  const sugg = await api.call('suggestPages', { channelIds: [boot.channels.find(c => c.title === 'Kitchen Science Hour').id] });
  assert.equal(sugg.channels.length, 1);
  sugg.channels.forEach(checkChannel);

  checkBootstrap(await api.call('refreshNow'));
  await assert.rejects(api.call('refreshNow'), e => e.code === 'busy');
  now += 6 * 60000;
  checkBootstrap(await api.call('refreshNow'));
  await assert.rejects(api.call('nope'), e => e.code === 'unknown_action');

  await api.call('savePages', { pages: [] });
  await assert.rejects(api.call('suggestPages', {}), e => e.code === 'no_pages');
});

test('mock seed holds the cases the screens need', async () => {
  const d = L.normalize(await createMockApi(seed, { now: () => NOW, latencyMs: 0 }).call('bootstrap'));
  const pids = L.pageIdSet(d);
  const deletedRef = seed.channels.find(c => c.subscribed && c.pageIds.some(id => !seed.pages.some(p => p.id === id)));
  assert.ok(deletedRef, 'seed has a subscribed channel that points at a deleted page');
  assert.ok(L.otherChannelIds(d).has(deletedRef.id), 'it shows in Other');
  assert.ok(d.channels.some(c => c.suggestedPageIds === 'none'), 'AI none');
  assert.ok(d.channels.some(c => Array.isArray(c.suggestedPageIds) && c.suggestedPageIds.length), 'AI suggestion');
  assert.ok(d.channels.some(c => c.pageIds.filter(id => pids.has(id)).length > 1), 'channel in two pages');
  assert.ok(d.channels.some(c => !c.subscribed && c.addedByLink), 'channel added by link');
  assert.ok(d.videos.some(v => v.live), 'live recording');
  assert.ok(L.watchedVideos(d).length >= 2, 'watched');
  assert.ok(L.feedVideos(d, 'other', { now: NOW }).length >= 3, 'Other feed');
});

// ---- player 80% rule ----

test('player: watched at 80% only when duration > 0', async () => {
  const { reachedWatched } = await import('../www/player.js');
  assert.equal(reachedWatched(80, 100), true);
  assert.equal(reachedWatched(79.9, 100), false);
  assert.equal(reachedWatched(5, 0), false);   // duration not known yet
  assert.equal(reachedWatched(0, 0), false);
  assert.equal(reachedWatched(NaN, 100), false);
});
