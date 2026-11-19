/**
 * Script Properties and debug logging.
 * Properties: KEY, GEMINI_API_KEY, GEMINI_MODEL, DEBUG, REFRESH_MINUTES, LIVE_HOURS.
 * Run state (also in Script Properties): lastRefresh, lastRefreshStart, lastLive, lastError,
 * refreshRunning, refreshRequested.
 */

var CONFIG_DEFAULTS = {
  GEMINI_MODEL: 'gemini-3.8-flash',
  DEBUG: '0',
  REFRESH_MINUTES: '60',
  LIVE_HOURS: '6'
};

var props_ = null;

/** All Script Properties, read once per execution. */
function allProps_() {
  if (!props_) props_ = PropertiesService.getScriptProperties().getProperties();
  return props_;
}

/** One property as a string ('' when missing, default when one exists). */
function cfg(name) {
  var p = allProps_();
  if (p[name] !== undefined && p[name] !== null && p[name] !== '') return String(p[name]);
  return CONFIG_DEFAULTS[name] !== undefined ? CONFIG_DEFAULTS[name] : '';
}

function cfgNum(name, fallback) {
  var n = Number(cfg(name));
  return isFinite(n) && n > 0 ? n : fallback;
}

/** Write a property and keep the cached copy in step. */
function setProp(name, value) {
  PropertiesService.getScriptProperties().setProperty(name, String(value));
  if (props_) props_[name] = String(value);
}

/** Read a property fresh (not from the cache): for run-state flags shared between executions. */
function freshProp(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (props_) props_[name] = v;
  return v || '';
}

function deleteProp(name) {
  PropertiesService.getScriptProperties().deleteProperty(name);
  if (props_) delete props_[name];
}

function isDebug() {
  var d = cfg('DEBUG').toLowerCase();
  return d === '1' || d === 'true' || d === 'yes' || d === 'on';
}

/** Debug log: writes only when the DEBUG property is on. Never pass keys or tokens. */
function dlog() {
  if (!isDebug()) return;
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    parts.push(typeof a === 'string' ? a : JSON.stringify(a));
  }
  console.log('[media-hub] ' + parts.join(' '));
}
