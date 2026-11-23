// Builds apps-script/Code.gs: the one file the owner pastes into the Google Sheet's
// Apps Script editor. It is core/calendar.js + apps-script/gas.js, unchanged.
import { readFileSync, writeFileSync } from 'node:fs';

const header = `/**
 * Kids Calendar: Google Apps Script back end.
 * Paste this whole file into Extensions > Apps Script of the calendar's Google Sheet.
 * Built from core/calendar.js and apps-script/gas.js by \`npm run build\`. Don't edit it here.
 *
 * @OnlyCurrentDoc  (the script can only open the Sheet it belongs to)
 */
`;
const out = header + '\n' + readFileSync('core/calendar.js', 'utf8') + '\n' + readFileSync('core/push.js', 'utf8') + '\n' + readFileSync('apps-script/gas.js', 'utf8');
writeFileSync('apps-script/Code.gs', out);
console.log(`apps-script/Code.gs written (${out.length} bytes)`);
