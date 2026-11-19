/**
 * One-time setup. Run setup() once from the Apps Script editor (it asks the owner to authorize).
 * Safe to run again: it never overwrites an existing KEY and keeps exactly one timer trigger.
 */

function setup() {
  var ss = SpreadsheetApp.getActive();
  for (var name in TABLES) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]);
    sh.setFrozenRows(1);
  }
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  var props = PropertiesService.getScriptProperties();
  var msg;
  if (!props.getProperty('KEY')) {
    var local = (typeof LOCAL_SECRETS !== 'undefined' && LOCAL_SECRETS && typeof LOCAL_SECRETS.KEY === 'string') ? LOCAL_SECRETS.KEY : '';
    if (local.length >= 32) {
      props.setProperty('KEY', local);
      msg = 'KEY set from Secrets.local.js.';
    } else {
      var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
      props.setProperty('KEY', key);
      msg = 'New KEY (shown once; paste it into the app Settings): ' + key;
    }
  } else {
    msg = 'KEY already set (not changed).';
  }
  for (var k in CONFIG_DEFAULTS) if (!props.getProperty(k)) props.setProperty(k, CONFIG_DEFAULTS[k]);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'timerTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('timerTick').timeBased().everyMinutes(15).create();

  Logger.log(msg);
  Logger.log('Tabs ready. Timer: timerTick every 15 min. Add GEMINI_API_KEY in Project Settings > Script properties.');
}

/** Ask the timer to refresh at its next tick (for use from the editor). */
function requestRefresh() {
  setProp('refreshRequested', '1');
}
