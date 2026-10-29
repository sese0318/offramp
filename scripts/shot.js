// Takes the README screenshot with headless Chrome or Edge.
// Start the app first (npm start), then in a second window:
//   npm run shot
//   npm run shot -- http://localhost:5174/?run=doomscroll-playlist&shot=1
// With live keys the run takes a while, so the page gets up to three minutes.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './env.js';

const url = process.argv[2] || 'http://localhost:5174/?run=one-more-episode&shot=1';
const out = join(root, 'docs', 'screenshot.png');
const browsers = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = browsers.find((b) => existsSync(b));
if (!browser) {
  console.log('No Chrome or Edge found. Set CHROME_PATH to the browser executable.');
  process.exit(1);
}
const profile = mkdtempSync(join(tmpdir(), 'offramp-shot-'));
const r = spawnSync(
  browser,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1280,2700', '--virtual-time-budget=180000', `--screenshot=${out}`, url],
  { stdio: 'inherit', timeout: 240000 }
);
console.log(r.status === 0 && existsSync(out) ? `Saved ${out}` : 'Screenshot failed.');
