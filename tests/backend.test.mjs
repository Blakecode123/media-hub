// Backend pure-logic tests: node --test
// Loads apps-script/Logic.js in a vm context (Apps Script files share one global scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../apps-script/Logic.js', import.meta.url), 'utf8');
const L = vm.createContext({});
vm.runInContext(code, L, { filename: 'Logic.js' });

// vm objects come from another realm; compare through JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-19T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString();
const CH = 'UC' + 'a'.repeat(22);

test('parseChannelLink: handles, channel IDs, user URLs and video URLs', () => {
  const cases = [
    ['@SomeChannel', { kind: 'handle', value: '@SomeChannel' }],
    ['  @some.channel-1  ', { kind: 'handle', value: '@some.channel-1' }],
    ['https://www.youtube.com/@SomeChannel', { kind: 'handle', value: '@SomeChannel' }],
    ['youtube.com/@SomeChannel/videos', { kind: 'handle', value: '@SomeChannel' }],
    ['https://m.youtube.com/@abc?si=xyz', { kind: 'handle', value: '@abc' }],
    [CH, { kind: 'channelId', value: CH }],
    ['https://www.youtube.com/channel/' + CH, { kind: 'channelId', value: CH }],
    ['https://www.youtube.com/channel/' + CH + '/featured', { kind: 'channelId', value: CH }],
    ['https://www.youtube.com/user/oldname', { kind: 'username', value: 'oldname' }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { kind: 'videoId', value: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10', { kind: 'videoId', value: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ?t=5', { kind: 'videoId', value: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/shorts/abcdefghijk', { kind: 'videoId', value: 'abcdefghijk' }],
    ['https://www.youtube.com/live/abcdefghijk?feature=x', { kind: 'videoId', value: 'abcdefghijk' }]
  ];
  for (const [input, want] of cases) assert.deepEqual(plain(L.parseChannelLink(input)), want, input);
});

test('parseChannelLink: rejects other links and junk', () => {
  for (const bad of ['', '   ', null, 42, 'https://vimeo.com/123', 'https://www.youtube.com/c/custom',
    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/', 'UCtooShort', '@ab']) {
    assert.equal(L.parseChannelLink(bad), null, String(bad));
  }
});

test('playlistIdFor: UU, UULF and UULV from a channel ID', () => {
  const rest = CH.slice(2);
  assert.equal(L.playlistIdFor(CH, 'UU'), 'UU' + rest);
  assert.equal(L.playlistIdFor(CH, 'LF'), 'UULF' + rest);
  assert.equal(L.playlistIdFor(CH, 'LV'), 'UULV' + rest);
  assert.equal(L.playlistIdFor(CH, 'XX'), null);
  assert.equal(L.playlistIdFor('notachannel', 'UU'), null);
});

test('isoDurationToSec: ISO 8601 durations', () => {
  assert.equal(L.isoDurationToSec('PT1H2M3S'), 3723);
  assert.equal(L.isoDurationToSec('PT45S'), 45);
  assert.equal(L.isoDurationToSec('PT3M'), 180);
  assert.equal(L.isoDurationToSec('P1DT2H'), 93600);
  assert.equal(L.isoDurationToSec('P0D'), 0);
  assert.equal(L.isoDurationToSec('PT0S'), 0);
  assert.equal(L.isoDurationToSec('P1W'), 604800);
  for (const bad of ['', 'P', 'PT', '1H', 'PT1X', null, undefined]) assert.equal(L.isoDurationToSec(bad), null, String(bad));
});

test('inWindow and isRefreshDue', () => {
  assert.equal(L.inWindow(daysAgo(29), NOW), true);
  assert.equal(L.inWindow(daysAgo(31), NOW), false);
  assert.equal(L.inWindow('not a date', NOW), false);
  const min = 60 * 1000;
  assert.equal(L.isRefreshDue(NOW, 0, 60, false), true);
  assert.equal(L.isRefreshDue(NOW, NOW - 58 * min, 60, false), true);
  assert.equal(L.isRefreshDue(NOW, NOW - 45 * min, 60, false), false);
  assert.equal(L.isRefreshDue(NOW, NOW - 1 * min, 60, true), true);
});

test('purgeOld: drops old videos; unrated state rows go, rated rows stay as IDs only', () => {
  const videos = [
    { id: 'new1', channelId: CH, published: daysAgo(2), title: 'x' },
    { id: 'old1', channelId: CH, published: daysAgo(40), title: 'y' },
    { id: 'old2', channelId: CH, published: daysAgo(35), title: 'z' }
  ];
  const states = [
    { videoId: 'new1', channelId: CH, state: 'seen', rating: '', updated: daysAgo(1) },
    { videoId: 'old1', channelId: CH, state: 'watched', rating: 'up', updated: daysAgo(1) },
    { videoId: 'old2', channelId: CH, state: 'hidden', rating: '', updated: daysAgo(1) }
  ];
  const r = plain(L.purgeOld(videos, states, NOW));
  assert.deepEqual(r.videos.map((v) => v.id), ['new1']);
  assert.equal(r.droppedVideos, 2);
  assert.deepEqual(r.states, [
    { videoId: 'new1', channelId: CH, state: 'seen', rating: '', updated: daysAgo(1) },
    { videoId: 'old1', channelId: CH, state: '', rating: 'up', updated: '' }
  ]);
});

test('Other rule: subscribed channel whose only page was deleted is in Other', () => {
  const pages = L.pageIdSet([{ id: 'p1' }, { id: 'p2' }]);
  assert.equal(L.isInOther({ subscribed: true, pageIds: ['p1'] }, pages), false);
  assert.equal(L.isInOther({ subscribed: true, pageIds: ['gone'] }, pages), true);
  assert.equal(L.isInOther({ subscribed: true, pageIds: [] }, pages), true);
  assert.equal(L.isInOther({ subscribed: true, pageIds: 'gone,p2' }, pages), false);
  assert.equal(L.isInOther({ subscribed: false, pageIds: [] }, pages), false);
});

test('prunePageRefs: deleted pages leave pageIds and suggestedPageIds', () => {
  const set = L.pageIdSet([{ id: 'p1' }]);
  const c = plain(L.prunePageRefs({ id: CH, pageIds: ['p1', 'p9'], suggestedPageIds: ['p9', 'p1'] }, set));
  assert.deepEqual(c.pageIds, ['p1']);
  assert.deepEqual(c.suggestedPageIds, ['p1']);
  const d = plain(L.prunePageRefs({ id: CH, pageIds: [], suggestedPageIds: ['p9'] }, set));
  assert.equal(d.suggestedPageIds, 'none');
  const e = plain(L.prunePageRefs({ id: CH, pageIds: [], suggestedPageIds: 'none' }, set));
  assert.equal(e.suggestedPageIds, 'none');
});

test('mergeChannel never overwrites owner fields', () => {
  const existing = {
    id: CH, title: 'Old', description: 'd', thumb: 't', subscribed: true, addedByLink: true,
    pageIds: ['p1'], suggestedPageIds: ['p2'], playlist: 'LF', hasLive: 'unknown', liveChecked: '', metaUpdated: ''
  };
  const fetched = {
    id: CH, title: 'New', subscribed: false, playlist: 'UU', hasLive: 'yes',
    pageIds: [], suggestedPageIds: 'none', addedByLink: false
  };
  const m = plain(L.mergeChannel(existing, fetched));
  assert.equal(m.title, 'New');
  assert.equal(m.subscribed, false);
  assert.equal(m.playlist, 'UU');
  assert.equal(m.hasLive, 'yes');
  assert.deepEqual(m.pageIds, ['p1']);
  assert.deepEqual(m.suggestedPageIds, ['p2']);
  assert.equal(m.addedByLink, true);
  assert.equal(m.description, 'd');
  assert.equal(existing.title, 'Old', 'input not changed');
});

test('applySubscriptions: new subs go to Other; gone subs kept if in a page or added by link', () => {
  const pages = L.pageIdSet([{ id: 'p1' }]);
  const A = 'UC' + 'A'.repeat(22), B = 'UC' + 'B'.repeat(22), C = 'UC' + 'C'.repeat(22),
    D = 'UC' + 'D'.repeat(22), E = 'UC' + 'E'.repeat(22);
  const channels = [
    { ...plain(L.newChannel(A)), subscribed: true, pageIds: ['p1'] },
    { ...plain(L.newChannel(B)), subscribed: true, pageIds: [] },
    { ...plain(L.newChannel(C)), subscribed: true, pageIds: ['deleted'] },
    { ...plain(L.newChannel(D)), subscribed: true, pageIds: [], addedByLink: true }
  ];
  const subs = [{ id: E, title: 'E', description: '', thumb: '' }];
  const r = plain(L.applySubscriptions(channels, subs, pages, '2026-11-19T00:00:00.000Z'));
  const byId = Object.fromEntries(r.channels.map((c) => [c.id, c]));
  assert.equal(byId[A].subscribed, false);
  assert.deepEqual(byId[A].pageIds, ['p1']);
  assert.equal(byId[B], undefined);
  assert.equal(byId[C], undefined);
  assert.equal(byId[D].subscribed, false);
  assert.equal(byId[E].subscribed, true);
  assert.deepEqual(byId[E].pageIds, []);
  assert.deepEqual(r.removedIds.sort(), [B, C].sort());
  // Incomplete subscription fetch: nothing changes.
  const same = plain(L.applySubscriptions(channels, null, pages, 'x'));
  assert.deepEqual(same.channels, plain(channels));
});

test('applyState and applyRating', () => {
  const t = '2026-11-19T00:00:00.000Z';
  let r = plain(L.applyState([], [{ videoId: 'v1', channelId: CH }, { videoId: 'v2', channelId: CH }], 'seen', t));
  assert.equal(r.count, 2);
  assert.deepEqual(r.states.map((s) => [s.videoId, s.state]), [['v1', 'seen'], ['v2', 'seen']]);
  let states = L.applyRating(r.states, 'v1', CH, 'up', t);
  assert.deepEqual(plain(states).find((s) => s.videoId === 'v1'), { videoId: 'v1', channelId: CH, state: 'watched', rating: 'up', updated: t });
  // Undo (null) keeps a rated row, drops an unrated one.
  r = plain(L.applyState(states, [{ videoId: 'v1', channelId: CH }, { videoId: 'v2', channelId: CH }], null, t));
  assert.deepEqual(r.states.map((s) => [s.videoId, s.state, s.rating]), [['v1', '', 'up']]);
  // Clearing the rating keeps the watched state.
  states = plain(L.applyRating(plain(L.applyState([], [{ videoId: 'v3', channelId: CH }], 'watched', t)).states, 'v3', CH, null, t));
  assert.deepEqual(states.map((s) => [s.videoId, s.state, s.rating]), [['v3', 'watched', '']]);
});

test('checkSetState validates the request', () => {
  assert.equal(L.checkSetState({ items: [{ videoId: 'v', channelId: CH }], state: 'hidden' }), '');
  assert.equal(L.checkSetState({ items: [{ videoId: 'v', channelId: CH }], state: null }), '');
  assert.equal(L.checkSetState({ items: [{ videoId: 'v', channelId: CH }], state: 'deleted' }), 'bad_state');
  assert.equal(L.checkSetState({ items: [], state: 'seen' }), 'bad_request');
  assert.equal(L.checkSetState({ items: [{ channelId: CH }], state: 'seen' }), 'bad_request');
});

test('checkKey: missing, short, wrong and right keys', () => {
  const key = 'k'.repeat(64);
  assert.equal(L.checkKey(key, key), true);
  assert.equal(L.checkKey(key, undefined), false, 'missing');
  assert.equal(L.checkKey(key, ''), false, 'empty');
  assert.equal(L.checkKey(key, 'k'.repeat(63) + 'x'), false, 'wrong');
  assert.equal(L.checkKey(key, 'k'.repeat(63)), false, 'wrong length');
  assert.equal(L.checkKey('short', 'short'), false, 'stored key too short');
  assert.equal(L.checkKey(undefined, undefined), false, 'no stored key');
  assert.equal(L.checkKey('', ''), false, 'empty stored key');
  assert.equal(L.checkKey(key, 12345), false, 'not a string');
});

test('checkGeminiOutput: drops unknown IDs; empty result is the none sentinel', () => {
  const A = 'UC' + 'A'.repeat(22), B = 'UC' + 'B'.repeat(22), C = 'UC' + 'C'.repeat(22);
  const raw = JSON.stringify([
    { channelId: A, pageIds: ['p1', 'zzz', 'p1'] },
    { channelId: B, pageIds: ['zzz'] },
    { channelId: 'UCunknown', pageIds: ['p1'] }
  ]);
  const r = plain(L.checkGeminiOutput(raw, ['p1', 'p2'], [A, B, C]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.suggestions, { [A]: ['p1'], [B]: 'none', [C]: 'none' });
  assert.equal(L.checkGeminiOutput('not json', ['p1'], [A]).ok, false);
  assert.equal(L.checkGeminiOutput('{"a":1}', ['p1'], [A]).ok, false);
});

test('needsSuggestion: only channels with no live pages and no suggestion', () => {
  const set = L.pageIdSet([{ id: 'p1' }]);
  assert.equal(L.needsSuggestion({ pageIds: [], suggestedPageIds: [] }, set), true);
  assert.equal(L.needsSuggestion({ pageIds: ['gone'], suggestedPageIds: '' }, set), true);
  assert.equal(L.needsSuggestion({ pageIds: [], suggestedPageIds: 'none' }, set), false);
  assert.equal(L.needsSuggestion({ pageIds: [], suggestedPageIds: ['p1'] }, set), false);
  assert.equal(L.needsSuggestion({ pageIds: ['p1'], suggestedPageIds: [] }, set), false);
});

test('cleanPages: keeps order, fills IDs, rejects bad input', () => {
  let n = 0;
  const make = () => 'gen' + (++n);
  const r = plain(L.cleanPages([{ id: 'a', name: ' Music ', hint: 'h' }, { name: 'Science' }], make));
  assert.deepEqual(r.pages, [{ id: 'a', name: 'Music', hint: 'h', order: 0 }, { id: 'gen1', name: 'Science', hint: '', order: 1 }]);
  assert.equal(L.cleanPages([{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }], make).error, 'bad_page_id');
  assert.equal(L.cleanPages([{ id: 'none', name: 'x' }], make).error, 'bad_page_id');
  assert.equal(L.cleanPages([{ id: 'a', name: '  ' }], make).error, 'bad_page_name');
  assert.equal(L.cleanPages('x', make).error, 'bad_request');
});

test('sheet cells: titles starting with =, +, - and dates survive a round trip', () => {
  const values = ['=SUM(A1)', '+61 400', '-5', '2026-11-19', '0012', 'plain', 12, true, ['p1', 'p2'], 'none'];
  for (const v of values) {
    const cell = L.encodeCell(v);
    assert.ok(typeof cell === 'string');
    assert.ok(!/^[=+\-@]/.test(cell) || typeof v === 'number', 'cell must not start like a formula: ' + cell);
    assert.deepEqual(plain(L.decodeCell(cell)), v);
  }
  assert.equal(L.encodeCell(''), '');
  assert.equal(L.encodeCell(null), '');
  assert.equal(L.decodeCell(''), '');
  assert.equal(L.decodeCell('hand typed'), 'hand typed');
  const cols = ['id', 'title', 'n'];
  const rows = [{ id: 'a', title: '=x', n: 3 }, { id: 'b', title: '', n: 0 }];
  const back = plain(L.valuesToRows([cols].concat(plain(L.rowsToValues(rows, cols))), cols));
  assert.deepEqual(back, rows);
  // Column order in the sheet may differ; blank rows are skipped.
  assert.deepEqual(plain(L.valuesToRows([['n', 'id'], ['5', '"x"'], ['', '']], ['id', 'n', 'title'])), [{ id: 'x', n: 5, title: '' }]);
});

test('videosOut: no Shorts, newest first, state and rating merged', () => {
  const vids = [
    { id: 'a', channelId: CH, title: 't', published: daysAgo(3), durationSec: 100, kind: 'video' },
    { id: 'b', channelId: CH, title: 't', published: daysAgo(1), durationSec: 50, kind: 'short' },
    { id: 'c', channelId: CH, title: 't', published: daysAgo(2), durationSec: 3600, kind: 'live' }
  ];
  const out = plain(L.videosOut(vids, [{ videoId: 'a', state: 'watched', rating: 'down' }]));
  assert.deepEqual(out.map((v) => v.id), ['c', 'a']);
  assert.equal(out[0].live, true);
  assert.equal(out[0].state, null);
  assert.equal(out[1].state, 'watched');
  assert.equal(out[1].rating, 'down');
});

test('channelOut: API shape', () => {
  const c = plain(L.channelOut({ ...plain(L.newChannel(CH)), pageIds: 'p1,p2', suggestedPageIds: 'none', subscribed: true }));
  assert.deepEqual(c.pageIds, ['p1', 'p2']);
  assert.equal(c.suggestedPageIds, 'none');
  assert.equal(c.subscribed, true);
  assert.equal(c.addedByLink, false);
});
