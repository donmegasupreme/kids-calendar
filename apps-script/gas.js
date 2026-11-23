// ============================================================================
// Kids Calendar: Google layer. Stores the calendar in the tabs of the Google
// Sheet this script belongs to, sends change emails from the owner's Gmail,
// and answers the app's requests. The calendar rules are in core/calendar.js.
// ============================================================================

var QUIET_MS = 2 * 60 * 1000; // wait this long after the last change before emailing

// Columns of each tab. Everything is stored as plain text; `num`, `json` and
// `bool` columns are converted when read.
var TABLES = {
  People: { key: 'people', cols: ['id', 'name', 'email', 'color', 'code', 'notify'], num: ['id', 'notify'] },
  Kids: { key: 'kids', cols: ['id', 'name', 'color'], num: ['id'] },
  Overrides: { key: 'overrides', cols: ['date', 'person_id', 'note', 'updated_by', 'updated_at'], num: ['person_id', 'updated_by'] },
  Events: {
    key: 'events',
    cols: ['id', 'date', 'start_time', 'end_time', 'title', 'kid_ids', 'location', 'notes', 'responsible_id',
      'created_by', 'updated_by', 'created_at', 'updated_at'],
    num: ['id', 'responsible_id', 'created_by', 'updated_by'], json: ['kid_ids'],
  },
  Activity: { key: 'activity', cols: ['ts', 'person_id', 'summary'], num: ['person_id'] },
  EmailQueue: { key: 'queue', cols: ['id', 'recipient_id', 'actor_id', 'summary', 'ts'], num: ['id', 'recipient_id', 'actor_id', 'ts'] },
  // Phones with notifications turned on (one row per phone).
  PushDevices: { key: 'push', cols: ['id', 'person_id', 'endpoint', 'p256dh', 'auth', 'device', 'created_at'], num: ['id', 'person_id'] },
};
var SETTINGS_JSON = ['pattern_cycle'];
var SETTINGS_NUM = ['next_id'];

// ---- one-time install (run from the script editor) ------------------------
function install() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var db = loadDb_(ss);
    if (!db.settings.setup_key) {
      db.settings.setup_key = randomCode_(10);
      db.dirty = true;
    }
    saveDb_(ss, db, true);
  } finally {
    lock.releaseLock();
  }
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sendChangeEmails'; });
  if (!has) ScriptApp.newTrigger('sendChangeEmails').timeBased().everyMinutes(5).create();
  var key = loadDb_(ss).settings.setup_key;
  Logger.log('Installed. Setup key: ' + key + ' (also in the Settings tab)');
  return key;
}

// ---- web app entry points --------------------------------------------------
function doGet() {
  return json_({ ok: true, app: 'kids-calendar', note: 'This address is the calendar\'s data service. Open the calendar app instead.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: 'Bad request', status: 400 });
  }
  if (!req || typeof req !== 'object') req = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ error: 'The calendar is busy. Try again in a moment.', status: 503 });
  }
  var out, pending = [], db;
  try {
    db = loadDb_(ss);
    ensurePushKeys_(db);
    out = coreHandle(db, req, nowInfo_(), randomInt_);
    pending = db.pendingPush || [];
    if (db.dirty) saveDb_(ss, db, false);
  } catch (err) {
    if (err instanceof CoreError) return json_({ error: err.message, status: err.status });
    console.error(err && err.stack ? err.stack : err);
    return json_({ error: 'Something went wrong in the Google script.', status: 500 });
  } finally {
    lock.releaseLock();
  }

  // Phone notifications go out after the change is saved and the lock is free.
  // A failed notification never fails the save.
  if (pending.length) {
    var results = [];
    try {
      results = sendPushes_(db.settings, pending);
      removeDeadDevices_(ss, results);
    } catch (err) {
      console.error('Notifications not sent: ' + (err && err.stack ? err.stack : err));
      results = [{ status: 0, reason: String(err && err.message ? err.message : err) }];
    }
    if (out && out.pushTest) {
      var r = results[0] || { status: 0, reason: 'not sent' };
      out = { pushTest: { ok: r.status >= 200 && r.status < 300, status: r.status, reason: r.reason } };
    }
  }
  return json_(out);
}

// Runs every 5 minutes (set up by install()).
function sendChangeEmails() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // another request is running: next time
  try {
    var db = loadDb_(ss);
    if (!db.queue.length) return;
    var result = coreFlush(db, Date.now(), QUIET_MS, function (m) {
      MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.body, name: db.settings.family_name || 'Kids calendar' });
    });
    if (db.dirty) saveDb_(ss, db, false);
    if (result.failed.length) console.error('Emails not sent (will retry): ' + result.failed.join('; '));
  } finally {
    lock.releaseLock();
  }
}

// ---- phone notifications (Web Push) ---------------------------------------
// The signing keys are made once and kept in the Settings tab. The private
// half never leaves the Sheet; the app only ever sees vapid_public.
function ensurePushKeys_(db) {
  if (db.settings.vapid_public && db.settings.vapid_private) return;
  try {
    var k = pushGenerateKeys(randomBytes_);
    db.settings.vapid_private = k.privateKey;
    db.settings.vapid_public = k.publicKey;
    db.dirty = true;
  } catch (err) {
    console.error('Could not make notification keys: ' + (err && err.stack ? err.stack : err));
  }
}

// Sends each pending notification. Returns [{ endpoint, status, reason }].
function sendPushes_(settings, pending) {
  if (!settings.vapid_private || !settings.vapid_public) return [];
  var subject = /^https:\/\//.test(settings.app_url || '') ? settings.app_url : 'mailto:kids-calendar@example.invalid';
  var nowSec = Math.floor(Date.now() / 1000);
  var tokens = {};
  // Build each request on its own, so one bad phone can't stop the others.
  var built = [];
  pending.forEach(function (p) {
    try {
      var origin = /^https:\/\/[^\/]+/.exec(p.device.endpoint)[0];
      if (!tokens[origin]) tokens[origin] = pushVapidAuthorization(p.device.endpoint, subject, settings.vapid_private, settings.vapid_public, nowSec);
      var payload = { title: String(p.payload.title).slice(0, 80), body: String(p.payload.body).slice(0, 400), url: p.payload.url };
      var body = pushEncrypt(p.device.p256dh, p.device.auth, pushUtf8(JSON.stringify(payload)), randomBytes_);
      built.push({ p: p, req: {
        url: p.device.endpoint,
        method: 'post',
        contentType: 'application/octet-stream',
        payload: body.map(function (b) { return b > 127 ? b - 256 : b; }), // Apps Script wants signed bytes
        headers: { Authorization: tokens[origin], 'Content-Encoding': 'aes128gcm', TTL: '86400', Urgency: 'normal', Topic: 'kidscalendar' },
        muteHttpExceptions: true,
        followRedirects: false,
      } });
    } catch (err) {
      console.error('Notification not built for ' + String(p.device.endpoint).slice(0, 60) + '…: ' + (err && err.message ? err.message : err));
      built.push({ p: p, error: String(err && err.message ? err.message : err) });
    }
  });
  var toSend = built.filter(function (b) { return b.req; });
  var responses = toSend.length ? UrlFetchApp.fetchAll(toSend.map(function (b) { return b.req; })) : [];
  var k = 0;
  return built.map(function (b) {
    if (!b.req) return { endpoint: b.p.device.endpoint, status: 0, reason: 'Could not prepare: ' + b.error };
    var res = responses[k++];
    var code = res.getResponseCode();
    var text = '';
    try { text = String(res.getContentText() || '').slice(0, 300); } catch (e) { text = ''; }
    if (code >= 300) console.error('Notification to ' + b.p.device.endpoint.slice(0, 60) + '… failed: ' + code + ' ' + text);
    return { endpoint: b.p.device.endpoint, status: code, reason: code >= 300 ? text : '' };
  });
}

// A 404 or 410 means the phone turned notifications off or the app was removed.
function removeDeadDevices_(ss, results) {
  var dead = results.filter(function (r) { return r.status === 404 || r.status === 410; }).map(function (r) { return r.endpoint; });
  if (!dead.length) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var db = loadDb_(ss);
    var before = db.push.length;
    db.push = db.push.filter(function (d) { return dead.indexOf(d.endpoint) < 0; });
    if (db.push.length !== before) saveDb_(ss, db, false);
  } finally {
    lock.releaseLock();
  }
}

// ---- storage ---------------------------------------------------------------
function loadDb_(ss) {
  var db = { settings: {}, dirty: false, _snap: {} };
  var st = ss.getSheetByName('Settings');
  if (st) {
    var rows = st.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var k = String(rows[i][0]);
      var v = rows[i][1] === null || rows[i][1] === undefined ? '' : String(rows[i][1]);
      if (!k) continue;
      if (SETTINGS_JSON.indexOf(k) >= 0) v = v ? JSON.parse(v) : [];
      else if (SETTINGS_NUM.indexOf(k) >= 0) v = Number(v) || 0;
      db.settings[k] = v;
    }
  }
  if (!db.settings.pattern_cycle) db.settings.pattern_cycle = [];
  db._snap.Settings = JSON.stringify(db.settings);

  Object.keys(TABLES).forEach(function (name) {
    var t = TABLES[name];
    var list = [];
    var sh = ss.getSheetByName(name);
    if (sh) {
      var vals = sh.getDataRange().getValues();
      var head = vals[0] || [];
      for (var r = 1; r < vals.length; r++) {
        var row = {};
        var empty = true;
        for (var c = 0; c < head.length; c++) {
          var col = String(head[c]);
          var raw = vals[r][c] === null || vals[r][c] === undefined ? '' : String(vals[r][c]);
          if (raw !== '') empty = false;
          if (t.json && t.json.indexOf(col) >= 0) row[col] = raw ? JSON.parse(raw) : [];
          else if (t.num.indexOf(col) >= 0) row[col] = raw === '' ? 0 : Number(raw);
          else row[col] = raw;
        }
        if (!empty) list.push(row);
      }
    }
    db[t.key] = list;
    db._snap[name] = JSON.stringify(list);
  });
  return db;
}

function saveDb_(ss, db, all) {
  var sRows = [['key', 'value']];
  Object.keys(db.settings).sort().forEach(function (k) {
    var v = db.settings[k];
    sRows.push([k, SETTINGS_JSON.indexOf(k) >= 0 ? JSON.stringify(v || []) : String(v === null || v === undefined ? '' : v)]);
  });
  if (all || JSON.stringify(db.settings) !== db._snap.Settings) writeSheet_(ss, 'Settings', sRows);

  Object.keys(TABLES).forEach(function (name) {
    var t = TABLES[name];
    var list = db[t.key] || [];
    if (!all && JSON.stringify(list) === db._snap[name]) return; // unchanged
    var rows = [t.cols];
    list.forEach(function (o) {
      rows.push(t.cols.map(function (c) {
        var v = o[c];
        if (t.json && t.json.indexOf(c) >= 0) return JSON.stringify(v || []);
        return v === null || v === undefined ? '' : String(v);
      }));
    });
    writeSheet_(ss, name, rows);
  });
}

function writeSheet_(ss, name, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  var range = sh.getRange(1, 1, rows.length, rows[0].length);
  range.setNumberFormat('@'); // plain text: stops Sheets turning dates and times into its own values
  range.setValues(rows.map(function (r) { return r.map(sheetSafe_); }));
  sh.setFrozenRows(1);
}

// Text starting with = + - @ could be read by Sheets as a formula, and a leading
// apostrophe would be swallowed. A leading apostrophe marks the cell as plain
// text; Sheets hides it and gives the text back unchanged.
function sheetSafe_(v) {
  return typeof v === 'string' && /^[=+\-@']/.test(v) ? "'" + v : v;
}

// ---- small helpers -----------------------------------------------------
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function nowInfo_() { var d = new Date(); return { iso: d.toISOString(), ms: d.getTime() }; }

// Random numbers from Google's UUID generator (stronger than Math.random).
var randomPool_ = [];
function randomInt_(n) {
  if (randomPool_.length < 2) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    // Skip the two 4-digit groups holding the UUID's fixed version and variant digits.
    for (var i = 0; i + 4 <= hex.length; i += 4) if (i !== 12 && i !== 16) randomPool_.push(parseInt(hex.slice(i, i + 4), 16));
  }
  return randomPool_.pop() % n;
}
function randomBytes_(n) {
  var out = [];
  while (out.length < n) {
    var v = randomInt_(65536);
    out.push(v >> 8, v & 255);
  }
  return out.slice(0, n);
}
function randomCode_(len) {
  var s = '';
  for (var i = 0; i < len; i++) s += CORE_CODE_ALPHABET[randomInt_(CORE_CODE_ALPHABET.length)];
  return s;
}
