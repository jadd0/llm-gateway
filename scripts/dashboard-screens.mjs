#!/usr/bin/env node
// Screenshots of the dashboard for review: /login and / at 1280 and a real 390 (device metrics emulation, not a
// window size), light and dark. Drives a headless Chrome over the DevTools protocol, so it adds no dependency.
//
//   DASHBOARD_URL=http://localhost:3200 DASHBOARD_TOKEN=... node scripts/dashboard-screens.mjs [out-dir] [range]
//
// The server must already be running (npm run dashboard) against a seeded database. The token is only posted to the
// login form to get a session cookie; it is never printed.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.DASHBOARD_URL ?? 'http://localhost:3200';
const token = process.env.DASHBOARD_TOKEN;
const out = process.argv[2] ?? 'docs/dashboard/screens';
const range = process.argv[3] ?? '24h';
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = Number(process.env.CDP_PORT ?? 9333);
if (!token) throw new Error('set DASHBOARD_TOKEN');
mkdirSync(out, { recursive: true });

const login = await fetch(`${base}/auth`, { method: 'POST', body: new URLSearchParams({ token }), redirect: 'manual' });
const cookie = /gw_dashboard=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
if (!cookie) throw new Error('login failed: no session cookie');

const profile = mkdtempSync(join(tmpdir(), 'dash-shots-'));
const proc = spawn(chrome, [`--remote-debugging-port=${port}`, '--headless=new', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    // Chrome is not up yet.
  }
}
if (!wsUrl) throw new Error('Chrome did not start');

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp('Page.enable');
  await cdp('Network.enable');
  const host = new URL(base).hostname;
  const sizes = [{ name: '1280', width: 1280, height: 900, mobile: false, dpr: 1 }, { name: '390', width: 390, height: 844, mobile: true, dpr: 2 }];
  const shots = [{ name: 'login', path: '/login', auth: false }, { name: 'overview', path: `/?range=${range}`, auth: true }];
  for (const scheme of ['light', 'dark']) {
    for (const size of sizes) {
      for (const shot of shots) {
        await cdp('Network.clearBrowserCookies');
        if (shot.auth) await cdp('Network.setCookie', { name: 'gw_dashboard', value: cookie, domain: host, path: '/', httpOnly: true, sameSite: 'Strict' });
        await cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: size.mobile });
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await cdp('Page.navigate', { url: base + shot.path });
        // Charts are drawn by the browser: wait for the four SVGs (overview) or the form (login).
        const ready = shot.auth ? "document.querySelectorAll('svg.recharts-surface').length >= 4 && document.querySelectorAll('.recharts-line-curve, .recharts-bar-rectangle').length > 0" : "!!document.querySelector('form')";
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) {
          await sleep(250);
          ok = (await cdp('Runtime.evaluate', { expression: ready, returnByValue: true })).result?.value === true;
        }
        if (!ok) throw new Error(`${shot.name} ${size.name} ${scheme}: page never became ready`);
        await sleep(300);
        const { cssContentSize } = await cdp('Page.getLayoutMetrics');
        const height = Math.ceil(cssContentSize.height);
        const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height, scale: 1 } });
        const file = join(out, `${shot.name}-${size.name}-${scheme}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        console.log(`${file} (${size.width}x${height} css px)`);
      }
    }
  }
} finally {
  ws.close();
  proc.kill();
}
