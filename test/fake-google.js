// A small stand-in for the Google services Code.gs uses, so the exact file the owner
// pastes into Apps Script can be run and tested in Node.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    if (!this.sheet.data.length) return [['']];
    return this.sheet.data.map((row) => row.slice());
  }
  setNumberFormat(f) { this.sheet.format = f; return this; }
  setValues(rows) {
    if (rows.length !== this.nr || rows.some((r) => r.length !== this.nc)) throw new Error('setValues: size mismatch');
    // With plain-text format every cell is kept as text, like the real Sheet.
    // Like Sheets: a leading apostrophe marks text and is not part of the value,
    // and an unprotected leading = would become a formula.
    this.sheet.data = rows.map((r) => r.map((v) => {
      if (typeof v === 'string' && v.startsWith("'")) return v.slice(1);
      if (typeof v === 'string' && v.startsWith('=')) return '#FORMULA!';
      return this.sheet.format === '@' ? String(v) : v;
    }));
    return this;
  }
}
class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.format = null; }
  getDataRange() { return new FakeRange(this, 1, 1, this.data.length, this.data[0]?.length || 0); }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr, nc); }
  clearContents() { this.data = []; return this; }
  setFrozenRows() { return this; }
}
export class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.set(n, s); return s; }
  toJSON() { return Object.fromEntries([...this.sheets].map(([k, v]) => [k, v.data])); }
  static fromJSON(obj) {
    const ss = new FakeSpreadsheet();
    for (const [k, data] of Object.entries(obj || {})) { const s = ss.insertSheet(k); s.data = data; s.format = '@'; }
    return ss;
  }
}

export function loadGas({ ss = new FakeSpreadsheet(), file = new URL('../apps-script/Code.gs', import.meta.url), mailer, log = () => {} } = {}) {
  const sent = [];
  const triggers = [];
  const ctx = {
    console: { log, error: log, warn: log },
    JSON, Math, Date, Number, String, Array, Object, parseInt, isNaN, Error,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (m) => { if (mailer) mailer(m); sent.push(m); } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
    },
    Utilities: { getUuid: () => randomUUID() },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((h) => ({ getHandlerFunction: () => h })),
      newTrigger: (h) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push(h) }) }) }),
    },
    Logger: { log },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: 'Code.gs' });
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { ctx, ss, sent, triggers, post };
}
