/**
 * Kids Calendar: Google Apps Script back end.
 * Paste this whole file into Extensions > Apps Script of the calendar's Google Sheet.
 * Built from core/calendar.js and apps-script/gas.js by `npm run build`. Don't edit it here.
 *
 * @OnlyCurrentDoc  (the script can only open the Sheet it belongs to)
 */

// ============================================================================
// Kids Calendar: the calendar rules. Plain JavaScript with no Google or Node
// calls, so the same code runs in Google Apps Script and in the Node tests.
//
// `db` is a plain object loaded from the Google Sheet:
//   settings: { family_name, pattern_start, pattern_cycle (array), setup_key,
//               app_url, next_id, created_at }
//   people, kids, overrides, events, activity, queue: arrays of row objects
// Dates are 'YYYY-MM-DD' text and never go through a time zone.
// ============================================================================

var CORE_COLORS = ['#2563eb', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2'];
var CORE_KID_COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
var CORE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
var CORE_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var CORE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var CORE_ACTIVITY_KEEP = 500;

// ---- dates -----------------------------------------------------------------
function coreIsDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var p = s.split('-').map(Number);
  var t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
}
function coreIsTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function coreUtc(s) { var p = s.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); }
function coreAddDays(s, n) { return new Date(coreUtc(s) + n * 86400000).toISOString().slice(0, 10); }
function coreDaysBetween(a, b) { return Math.round((coreUtc(b) - coreUtc(a)) / 86400000); }
function corePrettyDate(s) {
  var d = new Date(coreUtc(s));
  return CORE_DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + CORE_MONTHS[d.getUTCMonth()];
}
function corePrettyTime(t) {
  if (!t) return '';
  var p = t.split(':').map(Number);
  var ap = p[0] < 12 ? 'am' : 'pm';
  var h = p[0] % 12 || 12;
  return h + ':' + (p[1] < 10 ? '0' : '') + p[1] + ap;
}
function corePrettyRange(a, b) { return a === b ? corePrettyDate(a) : corePrettyDate(a) + ' to ' + corePrettyDate(b); }

// ---- errors and input checks --------------------------------------------
function CoreError(status, message) { this.status = status; this.message = message; }
function coreBad(msg) { return new CoreError(400, msg); }

function coreStr(v, max, field, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw coreBad(field + ' is required');
    return '';
  }
  if (typeof v !== 'string') throw coreBad(field + ' must be text');
  var s = v.trim();
  if (required && !s) throw coreBad(field + ' is required');
  if (s.length > max) throw coreBad(field + ' is too long');
  return s;
}
function coreEmail(v) {
  var e = coreStr(v, 200, 'Email', false);
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw coreBad('"' + e + '" doesn\'t look like an email address');
  return e;
}
function coreColor(v, fallback) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback; }
function coreCleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// ---- helpers over db ------------------------------------------------------
function coreFind(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function coreNextId(db) { db.settings.next_id = (Number(db.settings.next_id) || 0) + 1; return db.settings.next_id; }

function coreNewCode(db, randomInt) {
  for (;;) {
    var s = '';
    for (var i = 0; i < 8; i++) s += CORE_CODE_ALPHABET[randomInt(CORE_CODE_ALPHABET.length)];
    var code = s.slice(0, 4) + '-' + s.slice(4);
    var taken = db.people.some(function (p) { return p.code === code; });
    if (!taken) return code;
  }
}

function coreRecord(db, actor, summary, now) {
  db.activity.push({ ts: now.iso, person_id: actor.id, summary: summary });
  // Phone notifications: one per change, to every device of everyone else.
  // They share one tag, so a burst of changes replaces rather than stacks.
  if (!db.pendingPush) db.pendingPush = [];
  (db.push || []).forEach(function (d) {
    if (d.person_id !== actor.id) {
      db.pendingPush.push({ device: d, payload: { title: db.settings.family_name || 'Kids calendar',
        body: actor.name + ': ' + summary, url: db.settings.app_url || '' } });
    }
  });
  if (db.activity.length > CORE_ACTIVITY_KEEP) db.activity.splice(0, db.activity.length - CORE_ACTIVITY_KEEP);
  db.people.forEach(function (p) {
    if (p.id !== actor.id && p.notify && p.email) {
      db.queue.push({ id: coreNextId(db), recipient_id: p.id, actor_id: actor.id, summary: summary, ts: now.ms });
    }
  });
}

function coreAddPerson(db, body, randomInt) {
  var person = {
    id: coreNextId(db),
    name: coreStr(body.name, 60, 'Name', true),
    email: coreEmail(body.email),
    color: coreColor(body.color, CORE_COLORS[db.people.length % CORE_COLORS.length]),
    code: coreNewCode(db, randomInt),
    notify: 1,
  };
  db.people.push(person);
  return person;
}

function coreAddKid(db, name, color) {
  var kid = {
    id: coreNextId(db),
    name: coreStr(name, 60, "Child's name", true),
    color: coreColor(color, CORE_KID_COLORS[db.kids.length % CORE_KID_COLORS.length]),
  };
  db.kids.push(kid);
  return kid;
}

function coreEventSummary(e) {
  return '"' + e.title + '" on ' + corePrettyDate(e.date) + (e.start_time ? ' at ' + corePrettyTime(e.start_time) : '');
}

function coreReadEvent(db, body) {
  if (!coreIsDate(body.date)) throw coreBad('Pick a date for the event');
  var start = body.start_time || '';
  var end = body.end_time || '';
  if (start && !coreIsTime(start)) throw coreBad('Start time is not valid');
  if (end && !coreIsTime(end)) throw coreBad('End time is not valid');
  if (end && !start) throw coreBad('Add a start time as well as an end time');
  if (start && end && end < start) throw coreBad('End time is before the start time');
  var kidIds = [];
  (Array.isArray(body.kid_ids) ? body.kid_ids : []).forEach(function (id) {
    id = Number(id);
    if (coreFind(db.kids, id) && kidIds.indexOf(id) < 0) kidIds.push(id);
  });
  var resp = body.responsible_id ? Number(body.responsible_id) : 0;
  if (resp && !coreFind(db.people, resp)) throw coreBad('Unknown person');
  return {
    date: body.date, start_time: start, end_time: end,
    title: coreStr(body.title, 120, 'Title', true),
    kid_ids: kidIds,
    location: coreStr(body.location, 200, 'Location', false),
    notes: coreStr(body.notes, 2000, 'Notes', false),
    responsible_id: resp,
  };
}

function coreState(db, me) {
  var byDate = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; };
  return {
    family: {
      name: db.settings.family_name,
      pattern: { start: db.settings.pattern_start || null, cycle: db.settings.pattern_cycle || [] },
    },
    me: me.id,
    people: db.people.map(function (p) {
      return { id: p.id, name: p.name, email: p.email, color: p.color, code: p.code, notify: !!p.notify };
    }),
    kids: db.kids.map(function (k) { return { id: k.id, name: k.name, color: k.color }; }),
    overrides: db.overrides.slice().sort(byDate).map(function (o) {
      return { date: o.date, person_id: o.person_id, note: o.note };
    }),
    events: db.events.slice().sort(function (a, b) {
      return byDate(a, b) || (a.start_time || '').localeCompare(b.start_time || '');
    }),
    pushKey: db.settings.vapid_public || null,
    activity: db.activity.slice(-100).reverse().map(function (a) {
      var p = coreFind(db.people, a.person_id);
      return { ts: a.ts, summary: a.summary, person: p ? p.name : null };
    }),
  };
}

// ---- the API -----------------------------------------------------------------
// req: { action, code, ...fields }. now: { iso, ms }. randomInt(n) -> 0..n-1.
// Returns the response object; throws CoreError for user-facing problems.
// Sets db.dirty = true when something changed and needs saving.
function coreHandle(db, req, now, randomInt) {
  var action = req.action;
  var setUp = !!db.settings.family_name;

  if (action === 'status') return { setUp: setUp, needsSetupKey: true, pushKey: db.settings.vapid_public || null };

  if (action === 'setup') {
    if (setUp) throw new CoreError(409, 'This calendar is already set up. Ask for your code.');
    if (!db.settings.setup_key) throw new CoreError(403, 'Run the "install" step in the Google script first.');
    if (coreCleanCode(req.setupKey) !== coreCleanCode(db.settings.setup_key)) {
      throw new CoreError(403, 'Wrong setup key. It is in the Settings tab of the Google Sheet.');
    }
    var you = req.you || {}, other = req.other || {};
    coreStr(you.name, 60, 'Your name', true);
    db.settings.family_name = coreStr(req.familyName, 60, 'Calendar name', false) || 'Kids calendar';
    db.settings.created_at = now.iso;
    if (typeof req.appUrl === 'string' && /^https?:\/\//.test(req.appUrl)) db.settings.app_url = req.appUrl.slice(0, 300);
    var youP = coreAddPerson(db, { name: you.name, email: you.email }, randomInt);
    var otherP = other.name ? coreAddPerson(db, { name: other.name, email: other.email }, randomInt) : null;
    (Array.isArray(req.kids) ? req.kids : []).filter(function (k) { return typeof k === 'string' && k.trim(); })
      .slice(0, 12).forEach(function (k) { coreAddKid(db, k); });
    db.activity.push({ ts: now.iso, person_id: youP.id, summary: 'Set up the calendar' });
    db.dirty = true;
    return { code: youP.code, otherCode: otherP ? otherP.code : null };
  }

  // Everything else needs a valid code.
  var code = coreCleanCode(req.code);
  var me = null;
  if (code) {
    for (var i = 0; i < db.people.length; i++) {
      if (coreCleanCode(db.people[i].code) === code) { me = db.people[i]; break; }
    }
  }
  if (!me) throw new CoreError(401, "That code didn't work. Check it with the person who set up the calendar.");

  if (action === 'state') {
    if (!db.settings.app_url && typeof req.appUrl === 'string' && /^https?:\/\//.test(req.appUrl)) {
      db.settings.app_url = req.appUrl.slice(0, 300);
      db.dirty = true;
    }
    return coreState(db, me);
  }

  db.dirty = true;
  var m, e, old, p, kid, name;

  switch (action) {
    case 'custody': {
      if (!coreIsDate(req.from) || !coreIsDate(req.to)) throw coreBad('Pick the dates');
      if (req.to < req.from) throw coreBad('The end date is before the start date');
      var days = coreDaysBetween(req.from, req.to) + 1;
      if (days > 366) throw coreBad('Pick a year or less at a time');
      var pid = req.person_id ? Number(req.person_id) : 0;
      if (pid && !coreFind(db.people, pid)) throw coreBad('Unknown person');
      var note = coreStr(req.note, 200, 'Note', false);
      var dates = {};
      for (var d = 0; d < days; d++) dates[coreAddDays(req.from, d)] = true;
      db.overrides = db.overrides.filter(function (o) { return !dates[o.date]; });
      if (pid) {
        Object.keys(dates).forEach(function (date) {
          db.overrides.push({ date: date, person_id: pid, note: note, updated_by: me.id, updated_at: now.iso });
        });
      }
      var range = corePrettyRange(req.from, req.to);
      coreRecord(db, me, pid
        ? coreFind(db.people, pid).name + ' has the kids ' + range + (note ? ' (' + note + ')' : '')
        : range + ' put back to the usual schedule', now);
      return coreState(db, me);
    }

    case 'pattern': {
      var cycle = req.cycle;
      if (!Array.isArray(cycle) || cycle.length > 28) throw coreBad('The repeating schedule must be 28 days or fewer');
      if (cycle.length && !coreIsDate(req.start)) throw coreBad('Pick the date the schedule starts');
      var ids = cycle.map(function (id) { return id ? Number(id) : null; });
      ids.forEach(function (id) { if (id && !coreFind(db.people, id)) throw coreBad('Unknown person in schedule'); });
      db.settings.pattern_start = cycle.length ? req.start : '';
      db.settings.pattern_cycle = ids;
      coreRecord(db, me, cycle.length
        ? 'Changed the usual schedule (' + cycle.length + '-day repeat from ' + corePrettyDate(req.start) + ')'
        : 'Cleared the usual schedule', now);
      return coreState(db, me);
    }

    case 'addEvent': {
      e = coreReadEvent(db, req);
      e.id = coreNextId(db);
      e.created_by = me.id; e.updated_by = me.id; e.created_at = now.iso; e.updated_at = now.iso;
      db.events.push(e);
      var kids = e.kid_ids.map(function (id) { return coreFind(db.kids, id).name; });
      coreRecord(db, me, 'Added ' + coreEventSummary(e) + (kids.length ? ' for ' + kids.join(' & ') : ''), now);
      return coreState(db, me);
    }

    case 'updateEvent':
    case 'deleteEvent': {
      old = coreFind(db.events, Number(req.id));
      if (!old) throw new CoreError(404, 'That event has been deleted');
      if (action === 'deleteEvent') {
        db.events = db.events.filter(function (x) { return x !== old; });
        coreRecord(db, me, 'Removed ' + coreEventSummary(old), now);
        return coreState(db, me);
      }
      e = coreReadEvent(db, req);
      var moved = old.date !== e.date || old.start_time !== e.start_time;
      var was = corePrettyDate(old.date) + (old.start_time ? ' ' + corePrettyTime(old.start_time) : '');
      for (var k in e) old[k] = e[k];
      old.updated_by = me.id; old.updated_at = now.iso;
      coreRecord(db, me, moved
        ? 'Moved "' + e.title + '" from ' + was + ' to ' + corePrettyDate(e.date) + (e.start_time ? ' at ' + corePrettyTime(e.start_time) : '')
        : 'Updated ' + coreEventSummary(e), now);
      return coreState(db, me);
    }

    case 'addPerson': {
      p = coreAddPerson(db, req, randomInt);
      coreRecord(db, me, 'Added ' + p.name + ' to the calendar', now);
      return coreState(db, me);
    }

    case 'updatePerson': {
      p = coreFind(db.people, Number(req.id));
      if (!p) throw new CoreError(404, 'Unknown person');
      name = req.name !== undefined ? coreStr(req.name, 60, 'Name', true) : p.name;
      var em = req.email !== undefined ? coreEmail(req.email) : p.email;
      // Someone else can fill in a missing email, but not change or remove yours
      // (that would quietly stop your change emails).
      if (p.id !== me.id && p.email && em !== p.email) throw new CoreError(403, 'Only ' + p.name + ' can change their own email');
      var changed = name !== p.name || em !== p.email;
      p.name = name; p.email = em; p.color = coreColor(req.color, p.color);
      if (p.id === me.id && req.notify !== undefined) p.notify = req.notify ? 1 : 0; // only you can switch yours off
      if (changed) coreRecord(db, me, p.id === me.id ? 'Updated their details' : 'Updated ' + name + "'s details", now);
      return coreState(db, me);
    }

    case 'addKid': {
      kid = coreAddKid(db, req.name, req.color);
      coreRecord(db, me, 'Added ' + kid.name, now);
      return coreState(db, me);
    }

    case 'updateKid':
    case 'deleteKid': {
      kid = coreFind(db.kids, Number(req.id));
      if (!kid) throw new CoreError(404, 'Unknown child');
      if (action === 'deleteKid') {
        db.kids = db.kids.filter(function (x) { return x !== kid; });
        db.events.forEach(function (ev) { ev.kid_ids = ev.kid_ids.filter(function (id) { return id !== kid.id; }); });
        coreRecord(db, me, 'Removed ' + kid.name + ' from the calendar', now);
        return coreState(db, me);
      }
      name = coreStr(req.name, 60, "Child's name", true);
      var oldName = kid.name;
      kid.name = name; kid.color = coreColor(req.color, kid.color);
      if (name !== oldName) coreRecord(db, me, 'Renamed ' + oldName + ' to ' + name, now);
      return coreState(db, me);
    }

    // ---- phone notifications (Web Push) ----
    // Subscriptions belong to a person; each phone has its own. No activity entry.
    case 'pushSubscribe': {
      var sub = req.subscription || {};
      var keys = sub.keys || {};
      if (!corePushEndpointOk(sub.endpoint)) throw coreBad("This phone's notification address isn't one we recognise");
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(String(keys.p256dh || '')) || !/^[A-Za-z0-9_-]{16,32}$/.test(String(keys.auth || ''))) {
        throw coreBad("This phone's notification keys don't look right");
      }
      if (!db.push) db.push = [];
      db.push = db.push.filter(function (d) { return d.endpoint !== sub.endpoint; });
      db.push.push({ id: coreNextId(db), person_id: me.id, endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth,
        device: coreStr(typeof req.device === 'string' ? req.device.slice(0, 80) : '', 80, 'Device', false), created_at: now.iso });
      return coreState(db, me);
    }
    case 'pushUnsubscribe': {
      db.push = (db.push || []).filter(function (d) { return d.endpoint !== req.endpoint; });
      return coreState(db, me);
    }
    case 'pushTest': {
      // (No data changes, but keep db.dirty as is: newly made signing keys must still be saved.)
      var dev = null;
      (db.push || []).forEach(function (d) { if (d.endpoint === req.endpoint && d.person_id === me.id) dev = d; });
      if (!dev) throw new CoreError(404, 'Notifications are not turned on for this phone');
      db.pendingPush = [{ device: dev, test: true, payload: { title: db.settings.family_name || 'Kids calendar',
        body: 'Test notification: they work on this phone.', url: db.settings.app_url || '' } }];
      return { pushTest: true };
    }

    case 'family': {
      name = coreStr(req.name, 60, 'Calendar name', true);
      db.settings.family_name = name;
      coreRecord(db, me, 'Renamed the calendar to "' + name + '"', now);
      return coreState(db, me);
    }
  }

  db.dirty = false;
  throw new CoreError(404, 'Unknown request');
}

// Only send to the browsers' real push services, never to any other address.
function corePushEndpointOk(url) {
  if (typeof url !== 'string' || url.length > 1000) return false;
  var m = /^https:\/\/([a-z0-9.-]+)(\/|$)/i.exec(url);
  if (!m) return false;
  var host = m[1].toLowerCase();
  return host === 'fcm.googleapis.com' || host === 'web.push.apple.com' || /\.push\.apple\.com$/.test(host) ||
    host === 'updates.push.services.mozilla.com' || /\.notify\.windows\.com$/.test(host);
}

// ---- change emails ---------------------------------------------------------
// Sends one email per person once nobody has changed anything for quietMs.
// Queue rows are removed only after their email was sent, so a failed send is
// retried next time. send({to, subject, body}) throws on failure.
function coreFlush(db, nowMs, quietMs, send) {
  var byRecipient = {};
  db.queue.forEach(function (q) { (byRecipient[q.recipient_id] = byRecipient[q.recipient_id] || []).push(q); });
  var sent = 0, failed = [];
  Object.keys(byRecipient).forEach(function (rid) {
    var items = byRecipient[rid];
    var latest = Math.max.apply(null, items.map(function (q) { return Number(q.ts); }));
    if (latest > nowMs - quietMs) return; // still busy: wait
    var person = coreFind(db.people, Number(rid));
    var drop = function () {
      db.queue = db.queue.filter(function (q) { return items.indexOf(q) < 0; });
      db.dirty = true;
    };
    if (!person || !person.email || !person.notify) { drop(); return; }

    items.sort(function (a, b) { return Number(a.ts) - Number(b.ts) || a.id - b.id; });
    var actors = [];
    items.forEach(function (q) {
      var a = coreFind(db.people, q.actor_id);
      var n = a ? a.name : 'Someone';
      q._actor = n;
      if (actors.indexOf(n) < 0) actors.push(n);
    });
    var who = actors.join(' and ');
    var cal = db.settings.family_name || 'Kids calendar';
    var subject = items.length === 1 ? cal + ': ' + items[0].summary : cal + ': ' + who + ' made ' + items.length + ' changes';
    var lines = ['Hi ' + person.name + ',', '', who + ' updated the ' + cal + ':', ''];
    items.forEach(function (q) { lines.push(actors.length > 1 ? '- ' + q._actor + ': ' + q.summary : '- ' + q.summary); });
    lines.push('');
    if (db.settings.app_url) lines.push('Open the calendar: ' + db.settings.app_url, '');
    lines.push('You can turn these emails off in the app under Settings.');
    items.forEach(function (q) { delete q._actor; });

    try {
      send({ to: person.email, subject: subject, body: lines.join('\n') });
      drop();
      sent++;
    } catch (err) {
      failed.push(person.email + ': ' + (err && err.message ? err.message : err));
    }
  });
  return { sent: sent, failed: failed };
}

// ============================================================================
// Kids Calendar: Web Push crypto in plain JavaScript. Apps Script has no
// Web Crypto, so everything a push message needs is written out here:
//   - base64url and UTF-8 by hand
//   - SHA-256, HMAC-SHA-256, HKDF (RFC 5869)
//   - AES-128 (encrypt only) and AES-128-GCM
//   - the P-256 curve with BigInt: key pairs, ECDH, ECDSA with RFC 6979 k
//   - VAPID (RFC 8292) Authorization header and the aes128gcm body (RFC 8291,
//     RFC 8188) that carries the message to a phone.
//
// Bytes are plain arrays of numbers 0..255. Randomness is passed in as
// randomBytes(n). BigInt values are only made inside functions (never at load
// time and never with BigInt number literals), so a missing BigInt can't break the
// rest of the script. Not constant-time: fine for a server that signs with
// its own key, not for code an attacker can time.
// ============================================================================

// ---- bytes, base64url and UTF-8 --------------------------------------------
var PUSH_B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function pushB64uEncode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var n = (b0 << 16) | (b1 << 8) | b2;
    out += PUSH_B64U.charAt((n >> 18) & 63) + PUSH_B64U.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += PUSH_B64U.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += PUSH_B64U.charAt(n & 63);
  }
  return out; // no '=' padding
}

// Also accepts standard base64 ('+', '/', '=' padding), since browsers and
// libraries differ in how they write subscription keys.
function pushB64uDecode(str) {
  if (typeof str !== 'string') throw new Error('push: base64url input must be text');
  var s = str.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (s.length % 4 === 1) throw new Error('push: bad base64url length');
  var out = [];
  var acc = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = PUSH_B64U.indexOf(s.charAt(i));
    if (v < 0) throw new Error('push: bad base64url character');
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return out;
}

// String to UTF-8 bytes. Surrogate pairs become one 4-byte character; a lone
// surrogate becomes U+FFFD, as TextEncoder does.
function pushUtf8(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function pushConcat_() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    for (var j = 0; j < a.length; j++) out.push(a[j]);
  }
  return out;
}

// Calls the injected randomBytes(n) and checks what comes back. Masking with
// 255 also turns Apps Script's signed bytes (-128..127) into 0..255.
function pushRandom_(randomBytes, n) {
  var r = randomBytes(n);
  if (!r || r.length !== n) throw new Error('push: randomBytes(' + n + ') gave the wrong number of bytes');
  var out = [];
  for (var i = 0; i < n; i++) out.push(r[i] & 255);
  return out;
}

// ---- SHA-256 (FIPS 180-4) ---------------------------------------------------
var PUSH_SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function pushSha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  // Padding: 0x80, zeros, then the length in bits as a 64-bit big-endian number.
  var len = bytes.length;
  var msg = bytes.slice();
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  var bitsHi = Math.floor(len / 0x20000000), bitsLo = (len * 8) >>> 0;
  msg.push((bitsHi >>> 24) & 255, (bitsHi >>> 16) & 255, (bitsHi >>> 8) & 255, bitsHi & 255,
    (bitsLo >>> 24) & 255, (bitsLo >>> 16) & 255, (bitsLo >>> 8) & 255, bitsLo & 255);

  var w = new Array(64);
  for (var off = 0; off < msg.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      var j = off + t * 4;
      w[t] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) | 0;
    }
    for (t = 16; t < 64; t++) {
      var x = w[t - 15], y = w[t - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (k + S1 + ch + PUSH_SHA256_K[t] + w[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
  }
  var out = [];
  for (var i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
  return out;
}

// ---- HMAC-SHA-256 (RFC 2104) and HKDF (RFC 5869) ---------------------------
function pushHmacSha256(keyBytes, dataBytes) {
  var key = keyBytes.length > 64 ? pushSha256(keyBytes) : keyBytes.slice();
  while (key.length < 64) key.push(0);
  var ipad = [], opad = [];
  for (var i = 0; i < 64; i++) {
    ipad.push(key[i] ^ 0x36);
    opad.push(key[i] ^ 0x5c);
  }
  return pushSha256(pushConcat_(opad, pushSha256(pushConcat_(ipad, dataBytes))));
}

function pushHkdf(salt, ikm, info, length) {
  if (length > 255 * 32) throw new Error('push: HKDF length too long');
  var prk = pushHmacSha256(salt && salt.length ? salt : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ikm);
  var out = [], prev = [];
  for (var i = 1; out.length < length; i++) {
    prev = pushHmacSha256(prk, pushConcat_(prev, info, [i]));
    out = out.concat(prev);
  }
  return out.slice(0, length);
}

// ---- AES-128, encrypt only (FIPS 197) --------------------------------------
var PUSH_AES_SBOX = null; // built on first use

function pushAesSbox_() {
  if (PUSH_AES_SBOX) return PUSH_AES_SBOX;
  // Build the S-box from its definition: multiplicative inverse in GF(2^8),
  // then the affine transform. p walks through every non-zero byte as 3^i and
  // q as its inverse (1/3)^i.
  var sbox = new Array(256);
  var p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); // p *= 3
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; // q /= 3
    if (q & 0x80) q ^= 0x09;
    var x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    sbox[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  sbox[0] = 0x63;
  PUSH_AES_SBOX = sbox;
  return sbox;
}

function pushXtime_(b) { return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff; }

// 16-byte key to 11 round keys of 16 bytes each (176 bytes).
function pushAesExpandKey_(key) {
  if (key.length !== 16) throw new Error('push: AES-128 key must be 16 bytes');
  var sbox = pushAesSbox_();
  var w = key.slice();
  var rcon = 1;
  for (var i = 16; i < 176; i += 4) {
    var t = [w[i - 4], w[i - 3], w[i - 2], w[i - 1]];
    if (i % 16 === 0) {
      t = [sbox[t[1]] ^ rcon, sbox[t[2]], sbox[t[3]], sbox[t[0]]]; // RotWord, SubWord, Rcon
      rcon = pushXtime_(rcon);
    }
    for (var j = 0; j < 4; j++) w.push(w[i - 16 + j] ^ t[j]);
  }
  return w;
}

// Encrypts one 16-byte block with expanded key rk. The state is column-major,
// as in FIPS 197: s[r + 4c].
function pushAesEncryptBlock_(rk, block) {
  var sbox = pushAesSbox_();
  var s = new Array(16), i, r;
  for (i = 0; i < 16; i++) s[i] = block[i] ^ rk[i];
  for (r = 1; r <= 10; r++) {
    // SubBytes and ShiftRows together: row i moves left by i columns.
    var t = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var row = 0; row < 4; row++) t[row + 4 * c] = sbox[s[row + 4 * ((c + row) % 4)]];
    }
    // MixColumns (skipped in the last round).
    if (r < 10) {
      for (c = 0; c < 4; c++) {
        var a0 = t[4 * c], a1 = t[4 * c + 1], a2 = t[4 * c + 2], a3 = t[4 * c + 3];
        var all = a0 ^ a1 ^ a2 ^ a3;
        t[4 * c] = a0 ^ all ^ pushXtime_(a0 ^ a1);
        t[4 * c + 1] = a1 ^ all ^ pushXtime_(a1 ^ a2);
        t[4 * c + 2] = a2 ^ all ^ pushXtime_(a2 ^ a3);
        t[4 * c + 3] = a3 ^ all ^ pushXtime_(a3 ^ a0);
      }
    }
    // AddRoundKey.
    for (i = 0; i < 16; i++) s[i] = t[i] ^ rk[16 * r + i];
  }
  return s;
}

// ---- AES-128-GCM (NIST SP 800-38D), 12-byte IV, no associated data ---------
// 128-bit blocks for GHASH are held as four unsigned 32-bit words, big-endian.
function pushGcmWords_(b, off) {
  var w = [];
  for (var i = 0; i < 4; i++) {
    var j = off + 4 * i;
    w.push((((b[j] || 0) << 24) | ((b[j + 1] || 0) << 16) | ((b[j + 2] || 0) << 8) | (b[j + 3] || 0)) >>> 0);
  }
  return w;
}

// X * H in GF(2^128) with GCM's reflected bit order: walk X's bits from the
// most significant, shifting V = H right and reducing with 0xE1 << 120.
function pushGcmMul_(x, h) {
  var z0 = 0, z1 = 0, z2 = 0, z3 = 0;
  var v0 = h[0], v1 = h[1], v2 = h[2], v3 = h[3];
  for (var i = 0; i < 128; i++) {
    if ((x[i >>> 5] >>> (31 - (i & 31))) & 1) {
      z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3;
    }
    var lsb = v3 & 1;
    v3 = (v3 >>> 1) | ((v2 & 1) << 31);
    v2 = (v2 >>> 1) | ((v1 & 1) << 31);
    v1 = (v1 >>> 1) | ((v0 & 1) << 31);
    v0 = v0 >>> 1;
    if (lsb) v0 ^= 0xe1000000;
  }
  return [z0 >>> 0, z1 >>> 0, z2 >>> 0, z3 >>> 0];
}

// Returns ciphertext || 16-byte tag.
function pushAesGcmEncrypt_(key, iv, plaintext) {
  if (iv.length !== 12) throw new Error('push: GCM IV must be 12 bytes');
  var rk = pushAesExpandKey_(key);
  var h = pushGcmWords_(pushAesEncryptBlock_(rk, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
  var counter = function (n) { return iv.concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); };

  // CTR mode for the data, starting at counter 2 (counter 1 is J0, for the tag).
  var ct = [];
  for (var off = 0, n = 2; off < plaintext.length; off += 16, n++) {
    var ks = pushAesEncryptBlock_(rk, counter(n));
    for (var i = 0; i < 16 && off + i < plaintext.length; i++) ct.push(plaintext[off + i] ^ ks[i]);
  }

  // GHASH over the ciphertext (zero-padded blocks), then the length block:
  // 64-bit bit-lengths of the associated data (0) and the ciphertext.
  var y = [0, 0, 0, 0];
  for (off = 0; off < ct.length; off += 16) {
    var blk = ct.slice(off, off + 16);
    var xw = pushGcmWords_(blk, 0);
    y = pushGcmMul_([y[0] ^ xw[0], y[1] ^ xw[1], y[2] ^ xw[2], y[3] ^ xw[3]], h);
  }
  var bitLen = ct.length * 8;
  y = pushGcmMul_([y[0], y[1], y[2] ^ Math.floor(bitLen / 0x100000000), y[3] ^ (bitLen >>> 0)], h);

  var ek0 = pushAesEncryptBlock_(rk, counter(1));
  var tag = [];
  for (i = 0; i < 4; i++) {
    var word = y[i];
    tag.push(((word >>> 24) & 255) ^ ek0[4 * i], ((word >>> 16) & 255) ^ ek0[4 * i + 1],
      ((word >>> 8) & 255) ^ ek0[4 * i + 2], (word & 255) ^ ek0[4 * i + 3]);
  }
  return ct.concat(tag);
}

// ---- BigInt helpers ----------------------------------------------------------
function pushBytesToBig_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return BigInt('0x' + (hex || '0'));
}

// Always exactly len bytes, keeping leading zeros (they matter for r, s, x, y).
function pushBigToBytes_(x, len) {
  var hex = x.toString(16);
  if (hex.length > len * 2) throw new Error('push: number too big for ' + len + ' bytes');
  while (hex.length < len * 2) hex = '0' + hex;
  var out = [];
  for (var i = 0; i < len; i++) out.push(parseInt(hex.substr(2 * i, 2), 16));
  return out;
}

function pushMod_(a, m) {
  var r = a % m;
  return r < PUSH_EC.zero ? r + m : r;
}

// Inverse of a mod m (m prime, a not 0 mod m), by the extended Euclid method.
function pushModInv_(a, m) {
  var c = PUSH_EC;
  var r0 = m, r1 = pushMod_(a, m), t0 = c.zero, t1 = c.one;
  if (r1 === c.zero) throw new Error('push: no inverse of 0');
  while (r1 !== c.zero) {
    var q = r0 / r1;
    var r2 = r0 - q * r1; r0 = r1; r1 = r2;
    var t2 = t0 - q * t1; t0 = t1; t1 = t2;
  }
  return pushMod_(t0, m);
}

// ---- the P-256 curve (FIPS 186-4, SEC 2 secp256r1) ---------------------------
// y^2 = x^3 - 3x + b over the prime field p; G has prime order n.
var PUSH_EC = null; // built on first use: BigInt values are never made at load time

function pushEc_() {
  if (PUSH_EC) return PUSH_EC;
  var c = {
    zero: BigInt(0), one: BigInt(1), two: BigInt(2), three: BigInt(3), four: BigInt(4), eight: BigInt(8),
    p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    b: BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'),
    gx: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    gy: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
  };
  PUSH_EC = c;
  return c;
}

// Points are Jacobian {x, y, z} meaning the affine point (x/z^2, y/z^3);
// z = 0 is the point at infinity.
function pushEcDouble_(P) {
  var c = PUSH_EC, p = c.p;
  if (P.z === c.zero || P.y === c.zero) return { x: c.one, y: c.one, z: c.zero };
  // dbl-2001-b, using a = -3.
  var delta = P.z * P.z % p;
  var gamma = P.y * P.y % p;
  var beta = P.x * gamma % p;
  var alpha = c.three * pushMod_(P.x - delta, p) * ((P.x + delta) % p) % p;
  var x3 = pushMod_(alpha * alpha - c.eight * beta, p);
  var z3 = pushMod_((P.y + P.z) * (P.y + P.z) - gamma - delta, p);
  var y3 = pushMod_(alpha * pushMod_(c.four * beta - x3, p) - c.eight * (gamma * gamma % p), p);
  return { x: x3, y: y3, z: z3 };
}

function pushEcAdd_(P, Q) {
  var c = PUSH_EC, p = c.p;
  if (P.z === c.zero) return Q;
  if (Q.z === c.zero) return P;
  var z1z1 = P.z * P.z % p, z2z2 = Q.z * Q.z % p;
  var u1 = P.x * z2z2 % p, u2 = Q.x * z1z1 % p;
  var s1 = P.y * Q.z % p * z2z2 % p, s2 = Q.y * P.z % p * z1z1 % p;
  if (u1 === u2) {
    if (s1 === s2) return pushEcDouble_(P); // P + P
    return { x: c.one, y: c.one, z: c.zero }; // P + (-P)
  }
  var hh = pushMod_(u2 - u1, p), rr = pushMod_(s2 - s1, p);
  var h2 = hh * hh % p, h3 = h2 * hh % p, u1h2 = u1 * h2 % p;
  var x3 = pushMod_(rr * rr - h3 - c.two * u1h2, p);
  var y3 = pushMod_(rr * pushMod_(u1h2 - x3, p) - s1 * h3, p);
  var z3 = hh * P.z % p * Q.z % p;
  return { x: x3, y: y3, z: z3 };
}

// k * (ax, ay), double-and-add from the top bit. Returns affine {x, y}, or
// null for the point at infinity.
function pushEcMul_(k, ax, ay) {
  var c = pushEc_();
  var R = { x: c.one, y: c.one, z: c.zero };
  var A = { x: ax, y: ay, z: c.one };
  var bits = k.toString(2);
  for (var i = 0; i < bits.length; i++) {
    R = pushEcDouble_(R);
    if (bits.charAt(i) === '1') R = pushEcAdd_(R, A);
  }
  if (R.z === c.zero) return null;
  var zi = pushModInv_(R.z, c.p), zi2 = zi * zi % c.p;
  return { x: R.x * zi2 % c.p, y: R.y * zi2 % c.p * zi % c.p };
}

function pushEcOnCurve_(x, y) {
  var c = pushEc_(), p = c.p;
  if (x < c.zero || x >= p || y < c.zero || y >= p) return false;
  return pushMod_(y * y - (x * x % p * x - c.three * x + c.b), p) === c.zero;
}

// 65 bytes 0x04 || x || y to {x, y}, checking the point is on the curve.
function pushDecodePoint_(bytes, what) {
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('push: ' + what + ' must be a 65-byte uncompressed P-256 point');
  var x = pushBytesToBig_(bytes.slice(1, 33)), y = pushBytesToBig_(bytes.slice(33, 65));
  if (!pushEcOnCurve_(x, y)) throw new Error('push: ' + what + ' is not a point on P-256');
  return { x: x, y: y };
}

function pushEncodePoint_(P) {
  return [4].concat(pushBigToBytes_(P.x, 32), pushBigToBytes_(P.y, 32));
}

// 32 random bytes as a private key d, refusing d = 0 and d >= n (rather than
// drawing again, so a bad randomBytes shows up as an error).
function pushNewPrivate_(randomBytes) {
  var c = pushEc_();
  var d = pushBytesToBig_(pushRandom_(randomBytes, 32));
  if (d === c.zero || d >= c.n) throw new Error('push: random private key out of range, try again');
  return d;
}

function pushPrivateFromB64u_(b64u) {
  var c = pushEc_();
  var bytes = pushB64uDecode(b64u);
  if (bytes.length !== 32) throw new Error('push: private key must be 32 bytes');
  var d = pushBytesToBig_(bytes);
  if (d === c.zero || d >= c.n) throw new Error('push: private key out of range');
  return d;
}

function pushGenerateKeys(randomBytes) {
  var c = pushEc_();
  var d = pushNewPrivate_(randomBytes);
  var pub = pushEcMul_(d, c.gx, c.gy);
  return { privateKey: pushB64uEncode(pushBigToBytes_(d, 32)), publicKey: pushB64uEncode(pushEncodePoint_(pub)) };
}

// ---- ECDSA P-256 / SHA-256 with deterministic k (RFC 6979) ------------------
// hash: 32-byte SHA-256 digest; d: private key (BigInt). Returns r || s, 64 bytes.
function pushEcdsaSign_(hash, d) {
  var c = pushEc_(), n = c.n;
  var z = pushBytesToBig_(hash); // qlen = hlen = 256, so bits2int is just the number
  var x = pushBigToBytes_(d, 32);
  var h1 = pushBigToBytes_(z % n, 32); // bits2octets
  // HMAC-DRBG seeded with the key and the hash (RFC 6979 section 3.2, b to g).
  var V = [], K = [];
  for (var i = 0; i < 32; i++) { V.push(1); K.push(0); }
  K = pushHmacSha256(K, pushConcat_(V, [0], x, h1));
  V = pushHmacSha256(K, V);
  K = pushHmacSha256(K, pushConcat_(V, [1], x, h1));
  V = pushHmacSha256(K, V);
  for (;;) {
    V = pushHmacSha256(K, V); // one HMAC gives all 256 bits of T
    var k = pushBytesToBig_(V);
    if (k >= c.one && k < n) {
      var R = pushEcMul_(k, c.gx, c.gy);
      var r = R ? R.x % n : c.zero;
      if (r !== c.zero) {
        var s = pushModInv_(k, n) * ((z + r * pushMod_(d, n)) % n) % n;
        if (s !== c.zero) return pushBigToBytes_(r, 32).concat(pushBigToBytes_(s, 32));
      }
    }
    K = pushHmacSha256(K, pushConcat_(V, [0]));
    V = pushHmacSha256(K, V);
  }
}

// ---- VAPID (RFC 8292): the Authorization header for one push service -------
// The audience is the push service's origin: scheme and host (and a port that
// isn't the default), lower case, with no path.
function pushOrigin_(endpoint) {
  var m = /^(https?):\/\/(?:[^\/?#@]*@)?([^\/?#]+)/i.exec(String(endpoint || ''));
  if (!m) throw new Error('push: endpoint must be an http(s) URL');
  var scheme = m[1].toLowerCase(), host = m[2].toLowerCase();
  if ((scheme === 'https' && /:443$/.test(host)) || (scheme === 'http' && /:80$/.test(host))) host = host.replace(/:\d+$/, '');
  return scheme + '://' + host;
}

function pushVapidAuthorization(endpoint, subject, privateKeyB64u, publicKeyB64u, nowSeconds) {
  var d = pushPrivateFromB64u_(privateKeyB64u);
  var pubBytes = pushB64uDecode(publicKeyB64u);
  var pub = pushDecodePoint_(pubBytes, 'VAPID public key');
  var c = pushEc_(), mine = pushEcMul_(d, c.gx, c.gy);
  if (mine.x !== pub.x || mine.y !== pub.y) throw new Error('push: VAPID public key does not match the private key');
  var header = pushB64uEncode(pushUtf8('{"typ":"JWT","alg":"ES256"}'));
  var claims = { aud: pushOrigin_(endpoint), exp: Math.floor(nowSeconds) + 12 * 3600, sub: subject };
  var unsigned = header + '.' + pushB64uEncode(pushUtf8(JSON.stringify(claims)));
  var sig = pushEcdsaSign_(pushSha256(pushUtf8(unsigned)), d);
  return 'vapid t=' + unsigned + '.' + pushB64uEncode(sig) + ', k=' + pushB64uEncode(pubBytes);
}

// ---- message encryption (RFC 8291 with RFC 8188 aes128gcm) ------------------
// p256dh and auth come from the browser's PushSubscription. Returns the whole
// request body: header (salt, record size, our public key) then one record.
var PUSH_RECORD_SIZE = 4096;
var PUSH_MAX_PLAINTEXT = 3000;

function pushEncrypt(p256dhB64u, authB64u, plaintextBytes, randomBytes) {
  var c = pushEc_();
  var uaPublic = pushB64uDecode(p256dhB64u);
  var ua = pushDecodePoint_(uaPublic, 'subscription p256dh key');
  var auth = pushB64uDecode(authB64u);
  if (auth.length !== 16) throw new Error('push: subscription auth secret must be 16 bytes');
  if (plaintextBytes.length > PUSH_MAX_PLAINTEXT) throw new Error('push: message is too long (' + plaintextBytes.length + ' bytes, max ' + PUSH_MAX_PLAINTEXT + ')');

  // A fresh key pair and salt for every message.
  var asPrivate = pushNewPrivate_(randomBytes);
  var asPublic = pushEncodePoint_(pushEcMul_(asPrivate, c.gx, c.gy));
  var salt = pushRandom_(randomBytes, 16);

  // ECDH: the x coordinate of our private key times their public point.
  var shared = pushEcMul_(asPrivate, ua.x, ua.y);
  if (!shared) throw new Error('push: ECDH gave the point at infinity');
  var ecdhSecret = pushBigToBytes_(shared.x, 32);

  // Keys (RFC 8291 section 3.4, RFC 8188 section 2.2).
  var keyInfo = pushConcat_(pushUtf8('WebPush: info'), [0], uaPublic, asPublic);
  var ikm = pushHkdf(auth, ecdhSecret, keyInfo, 32);
  var cek = pushHkdf(salt, ikm, pushConcat_(pushUtf8('Content-Encoding: aes128gcm'), [0]), 16);
  var nonce = pushHkdf(salt, ikm, pushConcat_(pushUtf8('Content-Encoding: nonce'), [0]), 12);

  // One record, which is also the last: the data then the 0x02 delimiter.
  var record = pushAesGcmEncrypt_(cek, nonce, pushConcat_(plaintextBytes, [2]));
  var rs = PUSH_RECORD_SIZE;
  var head = pushConcat_(salt, [(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255], [asPublic.length], asPublic);
  return pushConcat_(head, record);
}

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
