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

  if (action === 'status') return { setUp: setUp, needsSetupKey: true };

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
