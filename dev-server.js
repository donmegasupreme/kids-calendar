// Local preview: serves the app from docs/ and runs the real apps-script/Code.gs
// against a pretend Google Sheet saved in .dev-data/sheet.json. Emails are not
// sent; they're written to .dev-data/outbox/.
//   npm run dev    then open http://localhost:8080
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeSpreadsheet, loadGas } from './test/fake-google.js';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, 'docs');
const dataDir = process.env.DEV_DATA || join(here, '.dev-data');
const port = Number(process.env.PORT || 8080);
mkdirSync(join(dataDir, 'outbox'), { recursive: true });
const sheetFile = join(dataDir, 'sheet.json');
const ss = existsSync(sheetFile) ? FakeSpreadsheet.fromJSON(JSON.parse(readFileSync(sheetFile, 'utf8'))) : new FakeSpreadsheet();
const persist = () => writeFileSync(sheetFile, JSON.stringify(ss.toJSON()));

const gas = loadGas({
  ss, log: console.log,
  mailer: (m) => {
    const f = join(dataDir, 'outbox', `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    writeFileSync(f, `To: ${m.to}\nSubject: ${m.subject}\n\n${m.body}\n`);
    console.log(`[mail] (not sent) to ${m.to}: ${m.subject}`);
  },
});
const key = gas.ctx.install();
persist();
console.log(`Setup key for this local copy: ${key}`);
setInterval(() => { gas.ctx.sendChangeEmails(); persist(); }, 15000).unref();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Also served under /kids-calendar/ to mimic a GitHub Pages project address.
  url.pathname = url.pathname.replace(/^\/kids-calendar(?=\/|$)/, '') || '/';
  if (url.pathname === '/api' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    const out = gas.ctx.doPost({ postData: { contents: raw } }).getContent();
    persist();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(out);
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end("window.KIDS_CAL_API = '/api';");
  }
  let file = normalize(join(site, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(site) || !existsSync(file) || !statSync(file).isFile()) file = join(site, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Kids Calendar preview on http://localhost:${port}`));
