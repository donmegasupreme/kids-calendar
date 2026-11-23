'use strict';

/* ============================================================
   Kids Calendar: front end (no build step, no libraries)
   Dates are 'YYYY-MM-DD' strings; they never go through UTC.
   ============================================================ */

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let S = null;                 // server state
let code = store.get('code'); // this person's code
let offline = false;
const ui = { view: 'cal', month: null, sel: null };

/* ---------- date helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
function todayStr() { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; }
const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => fromUtc(utc(s) + n * 864e5);
const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
const dow = (s) => (new Date(utc(s)).getUTCDay() + 6) % 7; // Mon = 0
const fmt = (s, opts) => new Date(utc(s)).toLocaleDateString('en-NZ', { ...opts, timeZone: 'UTC' }).replace(/,/g, '');
const longDate = (s) => fmt(s, { weekday: 'long', day: 'numeric', month: 'long' });
const shortDate = (s) => fmt(s, { weekday: 'short', day: 'numeric', month: 'short' });
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function timeStr(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return m ? `${h}:${pad(m)}${ap}` : `${h}${ap}`;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) +
    ', ' + new Date(iso).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
}

/* ---------- misc helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const person = (id) => S?.people.find((p) => p.id === id);
const kid = (id) => S?.kids.find((k) => k.id === id);
const me = () => person(S.me);
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const SHARE_ICON = '<svg class="share-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
const PALETTE = ['#2563eb', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

let toastTimer;
function toast(msg, err = false) {
  $toast.textContent = msg;
  $toast.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = err ? 'err' : ''; }, err ? 4000 : 2200);
}

/* ---------- who has the kids ---------- */
let overrideMap = new Map();
function indexState() { overrideMap = new Map(S.overrides.map((o) => [o.date, o])); }
function scheduled(date) {
  const { start, cycle } = S.family.pattern;
  if (!start || !cycle.length) return null;
  const n = cycle.length;
  return cycle[((diffDays(start, date) % n) + n) % n] || null;
}
function whoHas(date) {
  const o = overrideMap.get(date);
  return o ? o.person_id : scheduled(date);
}
const eventsOn = (date) => S.events.filter((e) => e.date === date);

/* ---------- server (Google Apps Script) ---------- */
// The address of the calendar's Google script is set in config.js.
const API = (window.KIDS_CAL_API || '').trim();
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');

// One POST per request, body sent as plain text with no custom headers, so the
// browser can call Google's script directly (no CORS preflight). The code goes
// in the body. Google always answers 200; problems come back as { error, status }.
async function api(action, body = {}) {
  if (!API) {
    const err = new Error('The calendar is not connected yet: the Google script address is missing from config.js.');
    err.notConnected = true;
    throw err;
  }
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, action, code, appUrl: APP_URL }),
      redirect: 'follow',
    });
  } catch {
    // Network failure. Browsers word this differently (Safari vs Chrome), so flag it here.
    const err = new Error('No connection. Check your internet and try again.');
    err.offline = true;
    throw err;
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    // An HTML page back means the script address is wrong or not shared with "Anyone".
    const err = new Error("The calendar's Google script didn't answer properly. Check its address in config.js and that it's deployed for Anyone.");
    err.notConnected = true;
    throw err;
  }
  if (data && data.error) {
    const err = new Error(data.error);
    err.status = data.status || 500;
    throw err;
  }
  return data;
}

function setState(next) {
  S = next;
  indexState();
  store.set('state', JSON.stringify(S));
}

async function refresh(quiet = true) {
  if (!code) return;
  try {
    const next = await api('state');
    const changed = JSON.stringify(next) !== JSON.stringify(S);
    const wasOffline = offline;
    setState(next);
    offline = false;
    // Don't redraw under someone: not while a sheet is open, a field has focus,
    // or the "calendar is ready" codes screen is showing.
    const typing = document.activeElement?.closest?.('#app') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const codesScreen = welcomeMode && typeof welcomeMode === 'object';
    if ((changed || wasOffline) && !$sheet.open && !typing && !codesScreen) render();
  } catch (e) {
    if (e.status === 401) { signOut(); toast(e.message, true); return; }
    offline = true;
    if (!quiet) toast("Can't reach the calendar. Showing the last copy.", true);
    if (!$sheet.open) render();
  }
}

let busy = false;
async function save(action, body, okMsg) {
  if (busy) return false; // stop double taps while Google is saving
  busy = true;
  const buttons = [...document.querySelectorAll('#sheet button, #app form button')].filter((b) => !b.disabled);
  buttons.forEach((b) => { b.disabled = true; });
  toast('Saving…');
  try {
    setState(await api(action, body || {}));
    if (okMsg) toast(okMsg);
    closeSheet();
    render();
    return true;
  } catch (e) {
    toast(e.offline ? "No connection. Your change wasn't saved." : e.message, true);
    return false;
  } finally {
    busy = false;
    buttons.forEach((b) => { if (b.isConnected) b.disabled = false; });
  }
}

function signOut() {
  code = null; S = null;
  store.set('code', null); store.set('state', null);
  render();
}

/* ---------- rendering ---------- */
function render() {
  if (!code || !S) { $tabs.hidden = true; return renderWelcome(); }
  $tabs.hidden = false;
  for (const b of $tabs.querySelectorAll('button')) {
    b.toggleAttribute('aria-current', b.dataset.view === ui.view);
    if (b.dataset.view === ui.view) b.setAttribute('aria-current', 'page');
  }
  const views = { cal: renderCal, up: renderUpcoming, log: renderLog, set: renderSettings };
  $app.innerHTML = (offline ? '<div class="offline">Offline: showing the last copy</div>' : '') + views[ui.view]();
  if (ui.view === 'set') pushCard();
}

function installBanner() {
  if (!isIOS || standalone || store.get('hideInstall')) return '';
  return `<div class="banner"><div class="grow"><b>Put this on your Home Screen</b><br>
    Tap ${SHARE_ICON} <b>Share</b> at the bottom of Safari, then <b>Add to Home Screen</b>.
    You'll enter your code once more in the installed app.</div>
    <button data-act="hide-install" aria-label="Dismiss">✕</button></div>`;
}

function legend() {
  return `<div class="legend">${S.people.map((p) =>
    `<span><i class="swatch" style="background:${p.color}"></i>${esc(p.name)}</span>`).join('')}</div>`;
}

function renderCal() {
  const today = todayStr();
  ui.sel ||= today;
  ui.month ||= today.slice(0, 7);
  const [y, m] = ui.month.split('-').map(Number);
  const first = `${ui.month}-01`;
  const gridStart = addDays(first, -dow(first));
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const noPattern = !S.family.pattern.cycle.length && !S.overrides.length;

  let cells = DOW.map((d) => `<div class="dow">${d[0]}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    if (i === 35 && d.slice(0, 7) !== ui.month) break;
    const who = person(whoHas(d));
    const prevWho = whoHas(addDays(d, -1));
    const evs = eventsOn(d);
    const cls = ['day', d.slice(0, 7) !== ui.month && 'other', d === today && 'today', d === ui.sel && 'sel'].filter(Boolean).join(' ');
    const label = `${longDate(d)}${who ? `, with ${who.name}` : ''}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}`;
    cells += `<button class="${cls}" data-day="${d}" ${who ? `data-who style="--who:${who.color}"` : ''} aria-label="${esc(label)}">
      ${overrideMap.has(d) ? '<i class="ov" title="Changed from usual"></i>' : ''}
      ${who && prevWho && prevWho !== who.id ? '<span class="swap" aria-hidden="true">⇄</span>' : ''}
      <span class="num">${Number(d.slice(8))}</span>
      <span class="dots">${evs.slice(0, 4).map((e) => {
        const k = kid(e.kid_ids[0]);
        return `<i class="dot" style="${k ? `background:${k.color}` : ''}"></i>`;
      }).join('')}</span>
    </button>`;
  }

  return `${installBanner()}
    <div class="cal-head">
      <button class="icon-btn" data-act="month" data-n="-1" aria-label="Previous month">‹</button>
      <h1>${title}</h1>
      <button class="icon-btn" data-act="month" data-n="1" aria-label="Next month">›</button>
      <button class="primary add-btn" data-act="add-event" aria-label="Add event">+ Event</button>
    </div>
    <div class="row">${legend()}<span class="grow"></span>
      ${ui.month !== today.slice(0, 7) ? '<button class="ghost today-btn" data-act="today">Back to today</button>' : ''}</div>
    <div class="grid" id="grid">${cells}</div>
    ${noPattern ? `<div class="banner" style="margin-top:12px"><div class="grow"><b>Set up the usual schedule</b><br>
      Tell the calendar how the kids normally go between you (week about, 2-2-3, weekends…).</div></div>
      <button class="primary block" data-act="pattern">Set usual schedule</button>` : ''}
    <div class="daypanel">${dayPanel(ui.sel)}</div>`;
}

function dayPanel(d) {
  const who = person(whoHas(d));
  const o = overrideMap.get(d);
  const evs = eventsOn(d).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  return `<div class="card">
    <h2>${longDate(d)}</h2>
    <div class="who-line" ${who ? `style="--who:${who.color}"` : ''}>
      <div class="grow">${who
        ? `<b>Kids with ${esc(who.name)}</b><span class="small muted">${o ? `Changed from usual${o.note ? `: ${esc(o.note)}` : ''}` : 'Usual schedule'}</span>`
        : '<b>No one set</b><span class="small muted">Not on the usual schedule</span>'}</div>
      <button data-act="custody" data-date="${d}">Change</button>
    </div>
    ${evs.length ? evs.map(eventRow).join('') : '<p class="muted small" style="margin:6px 0 2px">Nothing on this day.</p>'}
    <div class="spacer"></div>
    <button class="block" data-act="add-event" data-date="${d}">+ Add event</button>
  </div>`;
}

function eventRow(e) {
  const resp = person(e.responsible_id);
  const kids = e.kid_ids.map(kid).filter(Boolean);
  const time = e.start_time ? `${timeStr(e.start_time)}${e.end_time ? `<br>${timeStr(e.end_time)}` : ''}` : 'All day';
  return `<button class="event" data-act="edit-event" data-id="${e.id}">
    <div class="time">${time}</div>
    <div class="grow">
      <div class="title">${esc(e.title)}</div>
      ${e.location ? `<div class="meta">${esc(e.location)}</div>` : ''}
      ${resp ? `<div class="meta">${esc(resp.name)} taking them</div>` : ''}
      ${kids.length ? `<div>${kids.map((k) => `<span class="chip"><i class="swatch" style="background:${k.color};width:8px;height:8px"></i>${esc(k.name)}</span>`).join('')}</div>` : ''}
    </div>
  </button>`;
}

function renderUpcoming() {
  const today = todayStr();
  let html = '<h1>Coming up</h1>';
  let any = false;
  let prev = whoHas(addDays(today, -1));
  for (let i = 0; i < 90; i++) {
    const d = addDays(today, i);
    const who = whoHas(d);
    const handover = who && who !== prev ? person(who) : null;
    prev = who;
    const evs = eventsOn(d).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    if (!handover && !evs.length) continue;
    any = true;
    html += `<div class="date-head">${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDate(d)}</div><div class="card" style="padding:10px 14px">
      ${handover ? `<div class="handover" style="--who:${handover.color}"><i class="swatch" style="background:${handover.color}"></i>Kids go to <b>${esc(handover.name)}</b></div>` : ''}
      ${evs.map(eventRow).join('')}</div>`;
  }
  if (!any) html += '<div class="empty">Nothing in the next 90 days.<br>Add events with the + button on the calendar.</div>';
  return html;
}

function renderLog() {
  return `<h1>Changes</h1><div class="card">${S.activity.length ? S.activity.map((a) =>
    `<div class="log-item"><div><b>${esc(a.person || 'Someone')}</b>: ${esc(a.summary)}</div><div class="small muted">${ago(a.ts)}</div></div>`).join('')
    : '<div class="empty">No changes yet.</div>'}</div>`;
}

function patternSummary() {
  const { start, cycle } = S.family.pattern;
  if (!cycle.length) return 'Not set yet.';
  const names = [...new Set(cycle.filter(Boolean))].map((id) => person(id)?.name).filter(Boolean);
  return `${cycle.length}-day repeat between ${names.join(' and ') || 'nobody'}, starting ${shortDate(start)}.`;
}

function renderSettings() {
  const m = me();
  return `<h1>Settings</h1>
    ${installBanner()}
    <div class="card">
      <h2>You</h2>
      <form data-form="me">
        <label for="me-name">Your name</label>
        <input id="me-name" name="name" value="${esc(m.name)}" autocomplete="name" required>
        <label for="me-email">Your email</label>
        <input id="me-email" name="email" type="email" value="${esc(m.email || '')}" autocomplete="email" inputmode="email" placeholder="you@example.com">
        <label class="toggle">Email me when someone else changes something (as well as or instead of phone notifications)
          <input type="checkbox" name="notify" ${m.notify ? 'checked' : ''}></label>
        <div class="spacer"></div>
        <button class="primary block">Save</button>
      </form>
      <p class="small muted" style="margin-top:12px">Your code: <span class="code">${esc(m.code)}</span><br>
        Keep it: you need it to sign in on another phone, or in the Home Screen app.</p>
    </div>

    ${S.pushKey ? `<div class="card" id="push-card">
      <h2>Notifications on this phone</h2>
      <div id="push-body"><p class="muted small">Checking…</p></div>
    </div>` : ''}

    <div class="card">
      <h2>Usual schedule</h2>
      <p class="muted">${esc(patternSummary())}</p>
      <button class="block" data-act="pattern">Edit usual schedule</button>
    </div>

    <div class="card">
      <h2>People</h2>
      ${S.people.map((p) => `<div class="person">
        <i class="swatch" style="background:${p.color};width:22px;height:22px;border-radius:7px"></i>
        <div class="grow"><b>${esc(p.name)}</b>${p.id === S.me ? ' <span class="muted small">(you)</span>' : ''}
          <div class="small muted">${p.email ? esc(p.email) : 'No email: gets no updates'}</div>
          ${p.id !== S.me ? `<div class="small">Code: <span class="code" style="font-size:15px">${esc(p.code)}</span></div>` : ''}</div>
        <div class="row" style="gap:4px">
          ${p.id !== S.me ? `<button class="ghost" data-act="share" data-id="${p.id}">Send code</button>` : ''}
          <button class="ghost" data-act="person" data-id="${p.id}">Edit</button>
        </div>
      </div>`).join('')}
      <div class="spacer"></div>
      <button class="block" data-act="person">+ Add a person</button>
    </div>

    <div class="card">
      <h2>Kids</h2>
      ${S.kids.map((k) => `<div class="person"><i class="swatch" style="background:${k.color};width:22px;height:22px;border-radius:50%"></i>
        <div class="grow"><b>${esc(k.name)}</b></div><button class="ghost" data-act="kid" data-id="${k.id}">Edit</button></div>`).join('')
        || '<p class="muted">No kids added yet.</p>'}
      <div class="spacer"></div>
      <button class="block" data-act="kid">+ Add a child</button>
    </div>

    <div class="card">
      <h2>Calendar</h2>
      <form data-form="family">
        <label for="fam-name">Calendar name</label>
        <input id="fam-name" name="name" value="${esc(S.family.name)}" required>
        <div class="spacer"></div>
        <button class="block">Rename</button>
      </form>
    </div>

    <button class="danger block" data-act="signout">Sign out on this phone</button>
    <p class="small muted" style="text-align:center;margin-top:10px">Signing out only forgets your code on this phone.</p>`;
}

/* ---------- welcome / setup ---------- */
let welcomeMode = null; // 'code' | 'setup' | {codes}
async function renderWelcome() {
  if (!welcomeMode) {
    try {
      const st = await api('status');
      welcomeMode = st.setUp ? 'code' : 'setup';
      window._needsKey = st.needsSetupKey;
    } catch (e) {
      $app.innerHTML = `<div class="welcome"><img src="icons/icon-192.png" alt=""><h1 style="margin-top:14px">Kids Calendar</h1>
        <p class="muted">${esc(e.offline ? "Can't reach the calendar. Check your connection." : e.message)}</p>
        <button data-act="retry">Try again</button></div>`;
      return;
    }
  }
  const head = `<div class="welcome"><img src="icons/icon-192.png" alt=""><h1 style="margin-top:14px">Kids Calendar</h1>
    <p class="muted">Who has the kids, and what's on.</p>`;
  if (welcomeMode === 'code') {
    $app.innerHTML = `${head}${installBanner()}<div class="card">
      <form data-form="login">
        <label for="code">Enter your code</label>
        <input id="code" name="code" class="code-input" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EF23" required>
        <div class="spacer"></div>
        <button class="primary block">Open calendar</button>
      </form>
      <p class="small muted" style="margin-top:12px">The person who set up the calendar can send you your code from Settings.</p>
    </div></div>`;
  } else if (welcomeMode === 'setup') {
    $app.innerHTML = `${head}<div class="card">
      <h2>Set up your calendar</h2>
      <p class="small muted">Takes a minute. You'll get a code for yourself and one to send to the other parent.</p>
      <form data-form="setup">
        ${window._needsKey ? `<label for="sk">Setup key</label>
          <input id="sk" name="setupKey" required autocapitalize="characters" spellcheck="false" autocomplete="off">
          <p class="small muted" style="margin-top:6px">It's in the Settings tab of the calendar's Google Sheet.</p>` : ''}
        <label for="fn">Calendar name</label>
        <input id="fn" name="familyName" value="Kids calendar">
        <div class="two">
          <div><label for="yn">Your name</label><input id="yn" name="yourName" required autocomplete="given-name"></div>
          <div><label for="ye">Your email</label><input id="ye" name="yourEmail" type="email" inputmode="email" autocomplete="email"></div>
        </div>
        <div class="two">
          <div><label for="on">Other parent</label><input id="on" name="otherName"></div>
          <div><label for="oe">Their email</label><input id="oe" name="otherEmail" type="email" inputmode="email"></div>
        </div>
        <label>Kids</label>
        <div id="kid-rows"><div class="kid-row"><input name="kid" placeholder="First name" aria-label="Child's name"></div></div>
        <button type="button" class="ghost" data-act="kid-row">+ Another child</button>
        <div class="spacer"></div>
        <button class="primary block">Create calendar</button>
      </form>
      <p class="small muted" style="margin-top:12px">Emails let each of you know when the other adds or changes something.</p>
    </div>
    <button class="ghost" data-act="have-code">I already have a code</button></div>`;
  } else {
    const c = welcomeMode;
    $app.innerHTML = `${head}<div class="card">
      <h2>Your calendar is ready</h2>
      <label>Your code (keep this)</label><div class="code">${esc(c.code)}</div>
      ${c.otherCode ? `<label>Code for ${esc(c.otherName)}</label><div class="row"><div class="code grow">${esc(c.otherCode)}</div>
        <button data-act="share-code" data-code="${esc(c.otherCode)}" data-name="${esc(c.otherName)}">Send</button></div>` : ''}
      <div class="spacer"></div>
      <button class="primary block" data-act="enter">Open calendar</button>
    </div></div>`;
  }
}

/* ---------- sheets ---------- */
function openSheet(title, body, onSubmit) {
  $sheet.innerHTML = `<form class="sheet-in" method="dialog" novalidate>
    <div class="sheet-head"><h2>${title}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    ${body}</form>`;
  $sheet.querySelector('form').onsubmit = (ev) => { ev.preventDefault(); onSubmit(new FormData(ev.target), ev.target); };
  $sheet.showModal();
  $sheet.scrollTop = 0;
}
function closeSheet() { if ($sheet.open) $sheet.close(); }
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) closeSheet(); });
$sheet.addEventListener('close', () => render());

function eventSheet(ev, date) {
  const e = ev || { date: date || ui.sel || todayStr(), kid_ids: S.kids.length === 1 ? [S.kids[0].id] : [] };
  const kidsHtml = S.kids.length ? `<label>Which kids</label><div class="pick" data-pick="multi" data-name="kid_ids">
    ${S.kids.map((k) => `<button type="button" data-val="${k.id}" aria-pressed="${e.kid_ids.includes(k.id)}">
      <i class="swatch" style="background:${k.color}"></i>${esc(k.name)}</button>`).join('')}</div>` : '';
  openSheet(ev ? 'Edit event' : 'New event', `
    <label for="ev-title">What</label>
    <input id="ev-title" name="title" value="${esc(e.title || '')}" placeholder="Netball, school play, dentist…" required maxlength="120">
    <label for="ev-date">Date</label>
    <input id="ev-date" name="date" type="date" value="${e.date}" required>
    <div class="two">
      <div><label for="ev-st">Starts</label><input id="ev-st" name="start_time" type="time" value="${e.start_time || ''}"></div>
      <div><label for="ev-et">Ends</label><input id="ev-et" name="end_time" type="time" value="${e.end_time || ''}"></div>
    </div>
    <p class="small muted" style="margin-top:6px">Leave the times blank for an all-day event.</p>
    ${kidsHtml}
    <label for="ev-who">Who's taking them</label>
    <select id="ev-who" name="responsible_id"><option value="">Not decided</option>
      ${S.people.map((p) => `<option value="${p.id}" ${e.responsible_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <label for="ev-loc">Where</label>
    <input id="ev-loc" name="location" value="${esc(e.location || '')}" maxlength="200">
    <label for="ev-notes">Notes</label>
    <textarea id="ev-notes" name="notes" maxlength="2000" placeholder="Bring a plate, wear sports gear…">${esc(e.notes || '')}</textarea>
    <div class="sheet-actions">
      ${ev ? '<button type="button" class="danger" data-act="del-event" data-id="' + ev.id + '">Delete</button>' : ''}
      <button class="primary">${ev ? 'Save' : 'Add event'}</button>
    </div>`, (fd, form) => {
    const body = Object.fromEntries(fd);
    body.kid_ids = picked(form, 'kid_ids').map(Number);
    if (!body.title.trim()) return toast('Give the event a name', true);
    if (ev) body.id = ev.id;
    save(ev ? 'updateEvent' : 'addEvent', body, ev ? 'Saved' : 'Event added')
      .then((ok) => { if (ok) { ui.sel = body.date; ui.month = body.date.slice(0, 7); render(); } });
  });
}

function custodySheet(date) {
  const cur = whoHas(date);
  const o = overrideMap.get(date);
  openSheet('Who has the kids', `
    <div class="two">
      <div><label for="c-from">From</label><input id="c-from" name="from" type="date" value="${date}" required></div>
      <div><label for="c-to">To (inclusive)</label><input id="c-to" name="to" type="date" value="${date}" required></div>
    </div>
    <label>With</label>
    <div class="pick" data-pick="one" data-name="person_id">
      ${S.people.map((p) => `<button type="button" data-val="${p.id}" aria-pressed="${p.id === cur}"><i class="swatch" style="background:${p.color}"></i>${esc(p.name)}</button>`).join('')}
      ${S.family.pattern.cycle.length ? `<button type="button" data-val="" aria-pressed="false">Usual schedule</button>` : ''}
    </div>
    <label for="c-note">Note (optional)</label>
    <input id="c-note" name="note" value="${esc(o?.note || '')}" placeholder="e.g. swap for Dad's birthday" maxlength="200">
    <div class="sheet-actions"><button class="primary">Save</button></div>`, (fd, form) => {
    const body = Object.fromEntries(fd);
    const sel = form.querySelector('[data-name="person_id"] [aria-pressed="true"]');
    if (!sel) return toast('Pick who has the kids', true);
    body.person_id = sel.dataset.val ? Number(sel.dataset.val) : null;
    if (body.to < body.from) return toast('The end date is before the start date', true);
    save('custody', body, 'Saved');
  });
}

const PRESETS = {
  'Week about': (a, b) => [...Array(7).fill(a), ...Array(7).fill(b)],
  '2-2-3': (a, b) => [a, a, b, b, a, a, a, b, b, a, a, b, b, b],
  '2-2-5-5': (a, b) => [a, a, b, b, a, a, a, a, a, b, b, b, b, b],
  'Weekends with second': (a, b) => [a, a, a, a, a, b, b],
  'Every 2nd weekend': (a, b) => [a, a, a, a, a, b, b, a, a, a, a, a, a, a],
};

function patternSheet() {
  const p = S.family.pattern;
  const monday = addDays(todayStr(), -dow(todayStr()));
  let start = p.start || monday;
  let cycle = p.cycle.length ? [...p.cycle] : [];
  const ids = S.people.map((x) => x.id);
  let first = ids[0];

  openSheet('Usual schedule', `
    <p class="small muted">The pattern repeats forever from the start date. Change single days or holidays later with <b>Change</b> on a day.</p>
    <label for="p-start">Repeat starts on</label>
    <input id="p-start" name="start" type="date" value="${start}">
    ${S.people.length > 1 ? `<label>Starting with</label>
    <div class="pick" data-pick="one" data-name="first">${S.people.map((x) =>
      `<button type="button" data-val="${x.id}" aria-pressed="${x.id === first}"><i class="swatch" style="background:${x.color}"></i>${esc(x.name)}</button>`).join('')}</div>` : ''}
    <label>Quick start</label>
    <div class="presets">${Object.keys(PRESETS).map((k) => `<button type="button" data-preset="${esc(k)}">${esc(k)}</button>`).join('')}</div>
    <label>Tap a day to change who has them</label>
    <div class="cycle" id="cycle"></div>
    <div class="row" style="margin-top:8px">
      <span class="small muted grow" id="cycle-len"></span>
      <button type="button" data-len="-1">− Day</button>
      <button type="button" data-len="1">+ Day</button>
    </div>
    <div class="sheet-actions">
      ${p.cycle.length ? '<button type="button" class="danger" data-act="clear-pattern">Clear</button>' : ''}
      <button class="primary">Save schedule</button></div>`, () => {
    if (!cycle.length) return toast('Pick a quick start or add some days', true);
    save('pattern', { start, cycle }, 'Schedule saved');
  });

  const form = $sheet.querySelector('form');
  const drawCycle = () => {
    const box = form.querySelector('#cycle');
    box.innerHTML = cycle.map((id, i) => {
      const who = person(id);
      const d = addDays(start, i);
      return `<button type="button" data-i="${i}" ${who ? `data-who style="--who:${who.color}"` : ''} aria-label="Day ${i + 1}, ${DOW[dow(d)]}: ${esc(who?.name || 'no one')}">
        <b>${DOW[dow(d)]}</b>${esc(who ? who.name.slice(0, 6) : '–')}</button>`;
    }).join('');
    form.querySelector('#cycle-len').textContent = cycle.length
      ? `Repeats every ${cycle.length} day${cycle.length > 1 ? 's' : ''}${cycle.length % 7 === 0 ? ` (${cycle.length / 7} week${cycle.length > 7 ? 's' : ''})` : ''}`
      : 'No days yet';
  };
  drawCycle();
  form.querySelector('#p-start').onchange = (e) => { if (e.target.value) { start = e.target.value; drawCycle(); } };
  form.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.preset) {
      const a = first, b = ids.find((x) => x !== first) ?? first;
      cycle = PRESETS[t.dataset.preset](a, b);
      if (dow(start) !== 0 && /weekend/i.test(t.dataset.preset)) {
        start = addDays(start, -dow(start));
        form.querySelector('#p-start').value = start;
        toast('Moved the start to a Monday so weekends line up');
      }
      drawCycle();
    } else if (t.dataset.i !== undefined) {
      const i = Number(t.dataset.i);
      const order = [...ids, null];
      cycle[i] = order[(order.indexOf(cycle[i] ?? null) + 1) % order.length];
      drawCycle();
    } else if (t.dataset.len) {
      if (t.dataset.len === '1' && cycle.length < 28) cycle.push(cycle[cycle.length - 1] ?? first);
      if (t.dataset.len === '-1' && cycle.length) cycle.pop();
      drawCycle();
    } else if (t.closest('[data-name="first"]')) {
      first = Number(t.dataset.val);
    }
  });
}

function personSheet(p) {
  const isMe = p?.id === S.me;
  openSheet(p ? `Edit ${esc(p.name)}` : 'Add a person', `
    <label for="ps-name">Name</label><input id="ps-name" name="name" value="${esc(p?.name || '')}" required maxlength="60">
    <label for="ps-email">Email (for change emails)</label>
    <input id="ps-email" name="email" type="email" inputmode="email" value="${esc(p?.email || '')}">
    <label>Colour</label>
    <div class="colors" data-pick="one" data-name="color">${PALETTE.map((c) =>
      `<button type="button" data-val="${c}" style="background:${c}" aria-label="Colour ${c}" aria-pressed="${(p?.color || PALETTE[S.people.length % PALETTE.length]) === c}"></button>`).join('')}</div>
    ${!p ? '<p class="small muted" style="margin-top:12px">They get their own code to sign in. Grandparents, step-parents and carers can be added too.</p>' : ''}
    ${p && !isMe ? '<p class="small muted" style="margin-top:12px">Only they can switch their own emails off.</p>' : ''}
    <div class="sheet-actions"><button class="primary">${p ? 'Save' : 'Add'}</button></div>`, (fd, form) => {
    const body = Object.fromEntries(fd);
    body.color = picked(form, 'color')[0];
    if (p) body.id = p.id;
    save(p ? 'updatePerson' : 'addPerson', body, p ? 'Saved' : 'Added');
  });
}

function kidSheet(k) {
  openSheet(k ? `Edit ${esc(k.name)}` : 'Add a child', `
    <label for="k-name">Name</label><input id="k-name" name="name" value="${esc(k?.name || '')}" required maxlength="60">
    <label>Colour (for their events)</label>
    <div class="colors" data-pick="one" data-name="color">${['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#ef4444', '#64748b'].map((c, i) =>
      `<button type="button" data-val="${c}" style="background:${c}" aria-label="Colour ${c}" aria-pressed="${(k?.color || ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'][S.kids.length % 6]) === c}"></button>`).join('')}</div>
    <div class="sheet-actions">
      ${k ? `<button type="button" class="danger" data-act="del-kid" data-id="${k.id}">Remove</button>` : ''}
      <button class="primary">${k ? 'Save' : 'Add'}</button></div>`, (fd, form) => {
    const body = { name: fd.get('name'), color: picked(form, 'color')[0] };
    if (k) body.id = k.id;
    save(k ? 'updateKid' : 'addKid', body, k ? 'Saved' : 'Added');
  });
}

function picked(form, name) {
  return [...form.querySelectorAll(`[data-name="${name}"] [aria-pressed="true"]`)].map((b) => b.dataset.val);
}

async function shareCode(name, c) {
  const text = `Here's your code for our kids calendar: ${c}\n\nOpen ${APP_URL} in Safari on your iPhone, type in the code, then tap Share and "Add to Home Screen".`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast(`Copied: paste it into a text to ${name}`); }
  catch { toast(`${name}'s code is ${c}`); }
}

/* ---------- phone notifications (Web Push) ---------- */
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function pushCard(note) {
  const box = document.getElementById('push-body');
  if (!box) return;
  let html;
  if (!pushSupported) {
    html = isIOS && !standalone
      ? '<p>To get notifications, add Kids Calendar to your Home Screen (Share → Add to Home Screen), then open it from there and come back to this page.</p>'
      : '<p class="muted">This browser can\'t show notifications. You still get emails if they\'re on above.</p>';
  } else if (Notification.permission === 'denied') {
    html = '<p>Notifications are blocked for Kids Calendar. Turn them on in your phone\'s Settings → Notifications, then come back here.</p>';
  } else {
    const sub = await currentSubscription().catch(() => null);
    const on = !!(sub && Notification.permission === 'granted');
    html = on
      ? `<p>On: this phone gets a notification when someone else changes the calendar.</p>
         <div class="row wrap"><button data-act="push-test">Send a test notification</button>
         <button class="ghost" data-act="push-off">Turn off</button></div>`
      : `<p class="muted">Get a notification on this phone when someone else changes the calendar.</p>
         <button class="primary block" data-act="push-on">Turn on notifications</button>`;
  }
  if (note) html += `<p class="small" style="margin-top:10px">${esc(note)}</p>`;
  box.innerHTML = html;
}
function deviceName() {
  const ua = navigator.userAgent;
  return /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android phone' : 'Computer';
}
function pushOn(btn) {
  // Ask for permission straight away, inside the tap (iPhones require that).
  const asking = Notification.requestPermission();
  btn.disabled = true;
  (async () => {
    try {
      const perm = await asking;
      if (perm !== 'granted') return pushCard(perm === 'denied' ? '' : 'Notifications not turned on.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(S.pushKey) });
      setState(await api('pushSubscribe', { subscription: sub.toJSON(), device: deviceName() }));
      pushCard('Done. Tap "Send a test notification" to check.');
    } catch (e) {
      pushCard(`Couldn't turn on notifications: ${e.message || e}`);
    }
  })();
}
async function pushOff() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api('pushUnsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    pushCard('Notifications turned off on this phone.');
  } catch (e) { pushCard(`Couldn't turn them off: ${e.message || e}`); }
}
async function pushTest(btn) {
  btn.disabled = true;
  try {
    const sub = await currentSubscription();
    if (!sub) return pushCard('Notifications are not turned on for this phone.');
    const r = await api('pushTest', { endpoint: sub.endpoint });
    const t = r.pushTest || {};
    pushCard(t.ok ? 'Sent. It should appear within a few seconds (lock the phone to see it on the lock screen).'
      : `Not delivered. The notification service said ${t.status || 'nothing'}${t.reason ? `: ${t.reason}` : ''}`);
  } catch (e) {
    pushCard(`Test failed: ${e.message || e}`);
  }
}

/* ---------- events (one delegated handler) ---------- */
document.addEventListener('click', async (e) => {
  const pickBtn = e.target.closest('[data-pick] > button');
  if (pickBtn) {
    const group = pickBtn.parentElement;
    if (group.dataset.pick === 'one') group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === pickBtn));
    else pickBtn.setAttribute('aria-pressed', pickBtn.getAttribute('aria-pressed') !== 'true');
  }

  const tab = e.target.closest('#tabs button');
  if (tab) { ui.view = tab.dataset.view; render(); scrollTo(0, 0); return; }

  const day = e.target.closest('[data-day]');
  if (day) {
    ui.sel = day.dataset.day;
    if (ui.sel.slice(0, 7) !== ui.month) ui.month = ui.sel.slice(0, 7);
    render();
    document.querySelector('.daypanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const a = e.target.closest('[data-act]');
  if (!a) return;
  const id = Number(a.dataset.id);
  switch (a.dataset.act) {
    case 'close': closeSheet(); break;
    case 'month': {
      const [y, m] = ui.month.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + Number(a.dataset.n), 1));
      ui.month = d.toISOString().slice(0, 7);
      render();
      break;
    }
    case 'today': ui.month = todayStr().slice(0, 7); ui.sel = todayStr(); render(); break;
    case 'add-event': eventSheet(null, a.dataset.date); break;
    case 'edit-event': eventSheet(S.events.find((x) => x.id === id)); break;
    case 'del-event':
      if (confirmTwice(a, 'Tap again to delete')) save('deleteEvent', { id }, 'Deleted');
      break;
    case 'custody': custodySheet(a.dataset.date); break;
    case 'pattern': patternSheet(); break;
    case 'clear-pattern':
      if (confirmTwice(a, 'Tap again to clear')) save('pattern', { start: null, cycle: [] }, 'Schedule cleared');
      break;
    case 'person': personSheet(a.dataset.id ? person(id) : null); break;
    case 'kid': kidSheet(a.dataset.id ? kid(id) : null); break;
    case 'del-kid':
      if (confirmTwice(a, 'Tap again to remove')) save('deleteKid', { id }, 'Removed');
      break;
    case 'share': { const p = person(id); shareCode(p.name, p.code); break; }
    case 'share-code': shareCode(a.dataset.name, a.dataset.code); break;
    case 'signout':
      if (confirmTwice(a, 'Tap again to sign out')) signOut();
      break;
    case 'push-on': pushOn(a); break;
    case 'push-off': pushOff(); break;
    case 'push-test': pushTest(a); break;
    case 'hide-install': store.set('hideInstall', '1'); a.closest('.banner').remove(); break;
    case 'have-code': welcomeMode = 'code'; renderWelcome(); break;
    case 'retry': welcomeMode = null; renderWelcome(); break;
    case 'kid-row': {
      const row = document.createElement('div');
      row.className = 'kid-row';
      row.innerHTML = '<input name="kid" placeholder="First name" aria-label="Child\'s name">';
      document.getElementById('kid-rows').append(row);
      row.querySelector('input').focus();
      break;
    }
    case 'enter': welcomeMode = null; await refresh(false); ui.view = 'cal'; render(); break;
  }
});

// Destructive buttons need a second tap (no browser confirm() dialogs).
function confirmTwice(btn, msg) {
  if (btn.dataset.armed) return true;
  const old = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = msg;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3000);
  return false;
}

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const fd = new FormData(f);
  const btn = f.querySelector('button:not([type="button"])');
  if (btn) btn.disabled = true;
  try {
    switch (f.dataset.form) {
      case 'login': {
        code = String(fd.get('code')).trim().toUpperCase();
        try {
          setState(await api('state'));
          store.set('code', code);
          welcomeMode = null;
          ui.view = 'cal';
          render();
          toast(`Hi ${me().name}`);
        } catch (err) {
          code = null;
          toast(err.message, true);
        }
        break;
      }
      case 'setup': {
        const body = {
          setupKey: fd.get('setupKey') || undefined,
          familyName: fd.get('familyName'),
          you: { name: fd.get('yourName'), email: fd.get('yourEmail') },
          other: { name: fd.get('otherName'), email: fd.get('otherEmail') },
          kids: fd.getAll('kid'),
        };
        try {
          const r = await api('setup', body);
          code = r.code;
          store.set('code', code);
          welcomeMode = { ...r, otherName: body.other.name };
          renderWelcome();
        } catch (err) { toast(err.message, true); }
        break;
      }
      case 'me':
        await save('updatePerson', { id: S.me, name: fd.get('name'), email: fd.get('email'), notify: fd.get('notify') === 'on' }, 'Saved');
        break;
      case 'family':
        await save('family', { name: fd.get('name') }, 'Renamed');
        break;
    }
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

/* ---------- swipe months ---------- */
let touchX = null, touchY = null;
document.addEventListener('touchstart', (e) => {
  if (!e.target.closest('#grid')) return;
  touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    const [y, m] = ui.month.split('-').map(Number);
    ui.month = new Date(Date.UTC(y, m - 1 + (dx < 0 ? 1 : -1), 1)).toISOString().slice(0, 7);
    render();
  }
});

/* ---------- start ---------- */
(function start() {
  if (code) {
    try { const cached = JSON.parse(store.get('state')); if (cached) setState(cached); } catch {}
  }
  render();
  refresh();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
