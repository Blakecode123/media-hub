/**
 * Sheet tables (plan 2.1). Every tab has a header row; every cell is JSON-encoded text
 * (see encodeCell in Logic.js) and the tabs use plain-text format.
 */

var TABLES = {
  pages: ['id', 'name', 'hint', 'order'],
  channels: ['id', 'title', 'description', 'thumb', 'subscribed', 'addedByLink', 'pageIds',
    'suggestedPageIds', 'playlist', 'hasLive', 'liveChecked', 'metaUpdated'],
  videos: ['id', 'channelId', 'title', 'published', 'durationSec', 'kind', 'fetched'],
  state: ['videoId', 'channelId', 'state', 'rating', 'updated'],
  runs: ['time', 'kind', 'channels', 'units', 'newVideos', 'errors', 'ms']
};

var RUNS_KEEP = 3000;

function sheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() once.');
  return sh;
}

/** Read all rows of a table as objects. */
function readTable(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  if (lastRow < 1) return [];
  var cols = Math.max(sh.getLastColumn(), 1);
  var values = sh.getRange(1, 1, lastRow, cols).getValues();
  return valuesToRows(values, TABLES[name]);
}

/**
 * Write the whole table (header + rows). Used for merge-writes: callers read, merge by ID,
 * then write. Always runs under the script lock.
 */
function writeTable(name, rows) {
  var sh = sheet_(name);
  var cols = TABLES[name];
  var values = [cols].concat(rowsToValues(rows, cols));
  var need = values.length;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  var range = sh.getRange(1, 1, need, cols.length);
  range.setNumberFormat('@');
  range.setValues(values);
  var lastRow = sh.getLastRow();
  if (lastRow > need) sh.getRange(need + 1, 1, lastRow - need, Math.max(sh.getLastColumn(), cols.length)).clearContent();
  var lastCol = sh.getLastColumn();
  if (lastCol > cols.length) sh.getRange(1, cols.length + 1, need, lastCol - cols.length).clearContent();
}

/** Append one run-log row; trim the log to RUNS_KEEP rows. */
function appendRun(run) {
  var sh = sheet_('runs');
  var cols = TABLES.runs;
  var row = rowsToValues([run], cols)[0];
  sh.appendRow(row);
  var lastRow = sh.getLastRow();
  if (lastRow - 1 > RUNS_KEEP + 200) sh.deleteRows(2, lastRow - 1 - RUNS_KEEP);
}

/** Last n run rows, newest first. */
function lastRuns(n) {
  var sh = sheet_('runs');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var start = Math.max(2, lastRow - n + 1);
  var values = sh.getRange(start, 1, lastRow - start + 1, TABLES.runs.length).getValues();
  return valuesToRows([TABLES.runs].concat(values), TABLES.runs).reverse();
}

/** Run fn while holding the script lock. Returns {busy:true} if the lock is not free in 10 s. */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { busy: true };
  try {
    return { value: fn() };
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}
