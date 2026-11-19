// Official YouTube embedded player (IFrame Player API). No overlays, no changes to the player.
// Marks a video watched at 80% played (only when duration > 0) or when it ends.
// Nothing plays next: when a video ends, playback stops.

export const WATCHED_FRACTION = 0.8;
export const POLL_MS = 5000;

export function reachedWatched(time, duration) {
  return duration > 0 && time >= 0 && time / duration >= WATCHED_FRACTION;
}

let apiPromise = null;

function loadYouTubeApi() {
  if (globalThis.YT && globalThis.YT.Player) return Promise.resolve(globalThis.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => {
        apiPromise = null;
        reject(new Error('The YouTube player script did not load.'));
      };
      document.head.append(s);
    });
  }
  return apiPromise;
}

const ERRORS = {
  2: 'The video ID is not valid.',
  5: 'The browser cannot play this video.',
  100: 'This video was removed or made private.',
  101: 'The owner does not allow this video to play in other apps.',
  150: 'The owner does not allow this video to play in other apps.',
  153: 'YouTube needs the page referrer to play this video.',
};

export class Player {
  // mount: element the player iframe goes in. Callbacks get the video ID.
  constructor({ mount, onWatched = () => {}, onError = () => {}, log = () => {} }) {
    Object.assign(this, { mount, onWatched, onError, log });
    this.yt = null;
    this.ready = false;
    this.videoId = null;
    this.marked = false;
    this.timer = null;
  }

  async open(videoId) {
    this.videoId = videoId;
    this.marked = false;
    this._stopPoll();
    let YT;
    try {
      YT = await loadYouTubeApi();
    } catch (e) {
      this.onError(videoId, e.message);
      return;
    }
    if (this.videoId !== videoId) return; // another video was chosen while the script loaded
    if (this.yt && this.ready) {
      this.log('player', 'load', videoId);
      this.yt.loadVideoById(videoId);
      return;
    }
    if (this.yt) return; // still starting; onReady loads this.videoId
    const el = document.createElement('div');
    this.mount.replaceChildren(el);
    this.log('player', 'create', videoId);
    this.yt = new YT.Player(el, {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: { autoplay: 1, rel: 0, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => {
          this.ready = true;
          this.log('player', 'ready');
          const current = this._currentId();
          if (this.videoId && current && current !== this.videoId) this.yt.loadVideoById(this.videoId);
        },
        onStateChange: e => this._onState(e.data),
        onError: e => {
          this.log('player', 'error', e.data);
          this.onError(this.videoId, ERRORS[e.data] || `The player reported error ${e.data}.`);
        },
      },
    });
  }

  close() {
    this._stopPoll();
    if (this.yt) {
      try { this.yt.destroy(); } catch { /* already gone */ }
    }
    this.yt = null;
    this.ready = false;
    this.videoId = null;
    this.mount.replaceChildren();
  }

  // Current time and duration, for debug and tests in the preview.
  status() {
    if (!this.yt || !this.ready) return null;
    return { videoId: this._currentId(), time: this.yt.getCurrentTime(), duration: this.yt.getDuration(), marked: this.marked };
  }

  _currentId() {
    try {
      const d = this.yt.getVideoData && this.yt.getVideoData();
      return d && d.video_id;
    } catch {
      return null;
    }
  }

  _onState(state) {
    const S = window.YT.PlayerState;
    this.log('player', 'state', state, this.videoId);
    if (state === S.PLAYING) {
      this._check();
      this._startPoll();
    } else {
      this._stopPoll();
      if (state === S.ENDED) this._mark('ended');
      else if (state === S.PAUSED) this._check();
    }
  }

  _check() {
    if (this.marked || !this.yt || !this.ready || !this.videoId) return;
    // Guard: right after a video change the player can still report the old video's time.
    const current = this._currentId();
    if (current && current !== this.videoId) return;
    const t = this.yt.getCurrentTime(), d = this.yt.getDuration();
    if (reachedWatched(t, d)) this._mark(`${Math.round((t / d) * 100)}%`);
  }

  _mark(why) {
    if (this.marked || !this.videoId) return;
    const current = this._currentId();
    if (current && current !== this.videoId) return;
    this.marked = true;
    this.log('player', 'watched', this.videoId, why);
    this.onWatched(this.videoId);
  }

  _startPoll() {
    if (!this.timer) this.timer = setInterval(() => this._check(), POLL_MS);
  }

  _stopPoll() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
