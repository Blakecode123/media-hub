// Backend client (API contract: docs/plan-step1.md section 3), the outbox, and the mock backend.
// No DOM use at module level, so tests can import this file in Node.

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Codes that mean "try again later": the request may not have reached the backend,
// or the backend was busy (script lock) or gave a non-JSON page.
const RETRY_CODES = new Set(['network', 'busy', 'badreply', 'timeout']);
export const MAX_TRIES = 3; // for other server errors, then the entry is dropped

// ---- real backend ----

export function createHttpApi({ url, key, log = () => {}, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  return {
    mock: false,
    async call(action, body = {}, { keepalive = false } = {}) {
      const t0 = Date.now();
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl && !keepalive ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          // text/plain keeps this a "simple" request: no CORS preflight (Apps Script cannot answer one).
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...body, key, action }),
          redirect: 'follow',
          keepalive,
          signal: ctrl && !keepalive ? ctrl.signal : undefined,
        });
      } catch (e) {
        log('api', action, 'network error', e && e.message);
        throw new ApiError(e && e.name === 'AbortError' ? 'timeout' : 'network', e && e.message);
      } finally {
        if (timer) clearTimeout(timer);
      }
      let json;
      try {
        json = await res.json();
      } catch {
        log('api', action, 'non-JSON reply, HTTP', res.status);
        throw new ApiError('badreply', `HTTP ${res.status}`);
      }
      log('api', action, `${Date.now() - t0} ms`, json && json.ok ? 'ok' : json && json.error);
      if (!json || json.ok !== true) throw new ApiError((json && json.error) || 'error');
      return json;
    },
  };
}

// ---- outbox ----

// Every change goes here first. Entries are sent one at a time, in order.
// A held entry (an action with an undo toast open) stops the queue until it is released,
// so the backend sees actions in the same order as the screen.
export class Outbox {
  constructor({ storage, storageKey = 'mh.outbox', send, onChange = () => {}, onSent = () => {},
    onFail = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    Object.assign(this, { storage, storageKey, send, onChange, onSent, onFail, log, setTimer, clearTimer, now });
    this.entries = this._load();
    for (const e of this.entries) e.held = false; // undo toasts from a closed page are gone
    this.busy = false;
    this.blocked = false; // set on an 'auth' error until settings change
    this.inFlight = null;
    this.retryTimer = null;
    this.ackSeq = 0;
    this.acked = []; // recent sent entries with their ack number, for bootstrap races
  }

  _load() {
    try {
      const raw = this.storage && this.storage.getItem(this.storageKey);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _save() {
    try {
      this.storage && this.storage.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch (e) {
      this.log('outbox', 'save failed', e && e.message);
    }
  }

  get size() { return this.entries.length; }

  has(id) { return this.entries.some(e => e.id === id); }

  add(action, body, { held = false } = {}) {
    const entry = {
      id: `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      action, body, held, tries: 0, created: this.now(),
    };
    this.entries.push(entry);
    this._save();
    this.log('outbox', 'add', action, held ? '(held)' : '');
    this.onChange();
    if (!held) this.flush();
    return entry.id;
  }

  release(id) {
    const e = this.entries.find(x => x.id === id);
    if (e && e.held) {
      e.held = false;
      this._save();
      this.flush();
    }
  }

  releaseAll() {
    let any = false;
    for (const e of this.entries) if (e.held) { e.held = false; any = true; }
    if (any) this._save();
  }

  // Undo: true if the entry was still waiting and is now gone; false if it was sent or is sending.
  remove(id) {
    const i = this.entries.findIndex(x => x.id === id);
    if (i < 0 || this.entries[i] === this.inFlight) return false;
    this.entries.splice(i, 1);
    this._save();
    this.log('outbox', 'removed (undo)', id);
    this.onChange();
    this.flush();
    return true;
  }

  unblock() {
    this.blocked = false;
    this.flush();
  }

  ackedSince(seq) {
    return this.acked.filter(a => a.seq > seq).map(a => a.entry);
  }

  _scheduleRetry(tries) {
    if (this.retryTimer) return;
    const ms = Math.min(60000, 1000 * 2 ** Math.min(tries, 6));
    this.log('outbox', `retry in ${ms} ms`);
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.flush(); }, ms);
  }

  async flush({ keepalive = false } = {}) {
    if (this.busy || this.blocked) return;
    this.busy = true;
    try {
      for (;;) {
        const e = this.entries[0];
        if (!e || e.held) break;
        this.inFlight = e;
        let reply;
        try {
          reply = await this.send(e.action, e.body, { keepalive });
        } catch (err) {
          const code = (err && err.code) || 'error';
          e.tries++;
          if (code === 'auth') {
            this.blocked = true;
            this._save();
            this.onFail(e, err, { blocked: true });
            break;
          }
          if (RETRY_CODES.has(code) || e.tries < MAX_TRIES) {
            this._save();
            this.onFail(e, err, { retry: true });
            this._scheduleRetry(e.tries);
            break;
          }
          this.entries.shift();
          this._save();
          this.onFail(e, err, { dropped: true });
          this.onChange();
          continue;
        } finally {
          this.inFlight = null;
        }
        this.entries.shift();
        this._save();
        this.ackSeq++;
        this.acked.push({ seq: this.ackSeq, entry: e });
        if (this.acked.length > 100) this.acked.shift();
        this.onSent(e, reply);
        this.onChange();
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---- mock backend (?mock=1) ----

// Same actions and reply shapes as the real backend, kept in memory.
// seed: parsed mock/bootstrap.json. Its dates are moved so `mockNow` becomes now.
export function createMockApi(seed, { now = () => Date.now(), latencyMs = 150, failRate = 0, rng = Math.random,
  log = () => {} } = {}) {
  const shift = now() - Date.parse(seed.mockNow);
  const iso = v => new Date(Date.parse(v) + shift).toISOString();
  const db = {
    pages: seed.pages.map(p => ({ ...p })),
    channels: seed.channels.map(c => ({ ...c, pageIds: [...(c.pageIds || [])],
      suggestedPageIds: c.suggestedPageIds === 'none' ? 'none' : [...(c.suggestedPageIds || [])] })),
    videos: seed.videos.map(v => ({ ...v, published: iso(v.published), updated: v.updated ? iso(v.updated) : '' })),
    spare: (seed.spareVideos || []).map(v => ({ ...v })),
    lastRefresh: new Date(now() - 20 * 60000).toISOString(),
    lastError: seed.lastError || '',
    lastRefreshNow: 0,
  };
  let nextChannel = 1;

  const copy = x => JSON.parse(JSON.stringify(x));
  const pageIds = () => new Set(db.pages.map(p => p.id));
  const bootstrap = () => copy({ pages: db.pages, channels: db.channels, videos: db.videos,
    lastRefresh: db.lastRefresh, lastError: db.lastError });

  function takeSpare(channelId, n) {
    const out = [];
    while (out.length < n && db.spare.length) {
      const s = db.spare.shift();
      out.push({ id: s.id, channelId, title: s.title, durationSec: s.durationSec,
        published: new Date(now() - (out.length + 1) * 3 * 3600000).toISOString(),
        fetched: new Date(now()).toISOString(), state: null, rating: null, updated: '' });
    }
    return out;
  }

  function suggest(c) {
    const text = `${c.title} ${c.description}`.toLowerCase();
    const hits = db.pages.filter(p => `${p.name} ${p.hint || ''}`.toLowerCase()
      .split(/[^a-z0-9]+/).filter(w => w.length >= 4).some(w => text.includes(w)));
    c.suggestedPageIds = hits.length ? hits.map(p => p.id) : 'none';
  }

  const handlers = {
    bootstrap: () => bootstrap(),
    setState({ items = [], state = null }) {
      const ids = new Set(items.map(i => i.videoId));
      const at = new Date(now()).toISOString();
      for (const v of db.videos) if (ids.has(v.id)) { v.state = state || null; v.updated = at; }
      return { count: items.length };
    },
    rate({ videoId, rating = null }) {
      const v = db.videos.find(x => x.id === videoId);
      if (!v) throw new ApiError('not_found');
      v.rating = rating || null;
      if (rating) { v.state = 'watched'; v.updated = new Date(now()).toISOString(); }
      return {};
    },
    savePages({ pages = [] }) {
      db.pages = pages.map((p, i) => ({ id: String(p.id), name: String(p.name || ''), hint: String(p.hint || ''), order: i }));
      const keep = pageIds();
      const changed = [];
      for (const c of db.channels) {
        const before = JSON.stringify([c.pageIds, c.suggestedPageIds]);
        c.pageIds = c.pageIds.filter(id => keep.has(id));
        if (c.suggestedPageIds !== 'none') c.suggestedPageIds = c.suggestedPageIds.filter(id => keep.has(id));
        if (JSON.stringify([c.pageIds, c.suggestedPageIds]) !== before) changed.push(c);
      }
      return { pages: copy(db.pages), channels: copy(changed) };
    },
    setChannelPages({ channelId, pageIds: ids = [] }) {
      const c = db.channels.find(x => x.id === channelId);
      if (!c) throw new ApiError('not_found');
      const keep = pageIds();
      c.pageIds = ids.filter(id => keep.has(id));
      return { channel: copy(c) };
    },
    addChannel({ link = '' }) {
      const s = String(link).trim();
      const handle = (s.match(/@([\w.-]{3,})/) || [])[1];
      const chanId = (s.match(/\/channel\/(UC[\w-]{22})/) || [])[1];
      const vidId = (s.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{11})/) || [])[1];
      if (!handle && !chanId && !vidId) throw new ApiError('bad_link');
      const found = db.channels.find(c => c.id === chanId || (handle && c.handle === handle) ||
        (vidId && db.videos.some(v => v.id === vidId && v.channelId === c.id)));
      if (found) return { channel: copy(found), videos: copy(db.videos.filter(v => v.channelId === found.id)) };
      const id = chanId || `UCmock${String(nextChannel++).padStart(16, '0')}`;
      const name = handle ? handle.replace(/[-_.]/g, ' ') : `Linked channel ${nextChannel - 1}`;
      const c = { id, title: name, handle: handle || '', description: `A channel added by link (${s}).`,
        thumb: '', subscribed: false, addedByLink: true, pageIds: [], suggestedPageIds: [],
        playlist: 'LF', hasLive: 'unknown' };
      db.channels.push(c);
      const vids = takeSpare(id, 2);
      db.videos.push(...vids);
      return { channel: copy(c), videos: copy(vids) };
    },
    removeChannel({ channelId }) {
      const c = db.channels.find(x => x.id === channelId);
      if (!c) throw new ApiError('not_found');
      if (c.subscribed) throw new ApiError('subscribed');
      db.channels = db.channels.filter(x => x !== c);
      db.videos = db.videos.filter(v => v.channelId !== channelId);
      return {};
    },
    suggestPages({ channelIds } = {}) {
      const keep = pageIds();
      const targets = channelIds && channelIds.length
        ? db.channels.filter(c => channelIds.includes(c.id))
        : db.channels.filter(c => !c.pageIds.some(id => keep.has(id)) && Array.isArray(c.suggestedPageIds) && !c.suggestedPageIds.length);
      if (!db.pages.length) return { channels: [] };
      targets.forEach(suggest);
      return { channels: copy(targets) };
    },
    refreshNow() {
      if (now() - db.lastRefreshNow < 5 * 60000) throw new ApiError('busy');
      db.lastRefreshNow = now();
      const target = db.channels.find(c => c.subscribed && c.pageIds.length);
      if (target) db.videos.push(...takeSpare(target.id, 1));
      db.lastRefresh = new Date(now()).toISOString();
      return bootstrap();
    },
  };

  return {
    mock: true,
    db,
    async call(action, body = {}) {
      if (latencyMs) await new Promise(r => setTimeout(r, latencyMs));
      if (action !== 'bootstrap' && failRate && rng() < failRate) {
        log('mock', action, 'simulated network error');
        throw new ApiError('network', 'simulated');
      }
      const h = handlers[action];
      if (!h) throw new ApiError('unknown_action');
      const out = h(body);
      log('mock', action, 'ok');
      return { ok: true, ...out };
    },
  };
}
