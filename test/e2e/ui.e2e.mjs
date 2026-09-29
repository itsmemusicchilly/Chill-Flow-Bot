// Browser end-to-end check of the editor against the demo server (real API + fake Discord).
//   npm run e2e                       (needs a Chromium: set CHROMIUM_PATH, or `npx playwright-core install chromium`)
//   SHOTS=./shots npm run e2e         (also saves screenshots)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.E2E_PORT || 4100);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
  console.error('Build the UI first: npm run build');
  process.exit(2);
}

// ---- start a fresh demo server (its state lives in memory) -------------------------------------
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'scripts/demo-server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

const problems = [];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) problems.push(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// benign: the 401 from /api/me before logging in, and offline sandboxes blocking Discord's avatar CDN
page.on('console', (m) => { if (m.type() === 'error' && !/401|ERR_CERT_AUTHORITY_INVALID|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL/.test(m.text())) errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : null);

try {
  // ---- login + picker ------------------------------------------------------------------------
  await page.goto(`${BASE}/`);
  await page.getByRole('link', { name: 'Log in with Discord' }).waitFor();
  await shot('01-login');
  await page.goto(`${BASE}/demo-login`);
  await page.getByRole('heading', { name: 'Choose a server' }).waitFor();
  ok(await page.getByText('Pixel Café').isVisible(), 'picker lists the server the bot is in');
  ok((await page.getByRole('link', { name: /Add bot/ }).count()) === 1, 'server without the bot shows "Add bot"');
  await shot('02-picker');

  await page.getByRole('button', { name: /Pixel Café/ }).click();
  await page.getByRole('heading', { name: 'Build your first flow' }).waitFor();

  // ---- template ---------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Create a flow' }).click();
  await page.getByRole('button', { name: /Support tickets/ }).click();
  await page.locator('.fnode').first().waitFor();
  await page.waitForTimeout(600);
  ok((await page.locator('.fnode').count()) === 7, 'ticket template renders 7 nodes');
  ok((await page.locator('.react-flow__edge').count()) === 6, 'ticket template renders 6 connections');
  ok((await page.locator('.out.button').count()) === 1, 'the Close button has its own output');
  const vp = page.locator('.canvas');
  const canvasBox = await vp.boundingBox();
  const boxes = await page.locator('.fnode').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  ok(boxes.every((b) => b.left >= canvasBox.x - 2 && b.right <= canvasBox.x + canvasBox.width + 2), 'the whole flow is fitted into view');
  await shot('04-ticket-template');

  // ---- inspector ----------------------------------------------------------------------------------
  await page.locator('.fnode', { hasText: 'Slash Command' }).click();
  await page.getByRole('complementary', { name: 'Node settings' }).waitFor();
  const nameInput = page.getByLabel('Command name');
  ok((await nameInput.inputValue()) === 'ticket', 'inspector shows the command name');
  await nameInput.fill('help');
  ok((await page.locator('.fnode', { hasText: '/help' }).count()) === 1, 'node summary follows the edited field');

  await page.locator('.fnode', { hasText: 'Send Message' }).nth(1).click();
  const buttonsBefore = await page.locator('.out.button').count();
  await page.locator('.field', { has: page.locator('label', { hasText: /^Buttons$/ }) }).getByRole('button', { name: '+ Add' }).click();
  await page.waitForTimeout(300);
  ok((await page.locator('.out.button').count()) === buttonsBefore + 1, 'adding a button in the inspector adds an output on the node');

  // ---- palette ----------------------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: /Give Role/ }).click();
  await page.waitForTimeout(300);
  ok((await page.locator('.fnode', { hasText: 'Give Role' }).count()) === 1, 'clicking a palette item adds the node');
  const rects = await page.locator('.fnode').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const overlap = rects.some((a, i) => rects.some((b, j) => i < j && a.left < b.right - 4 && b.left < a.right - 4 && a.top < b.bottom - 4 && b.top < a.bottom - 4));
  ok(!overlap, 'a newly added node does not land on top of another node');
  const wait = page.getByRole('button', { name: 'Wait', exact: true });
  const box = await vp.boundingBox();
  await wait.dragTo(vp, { targetPosition: { x: box.width - 260, y: box.height - 140 } });
  await page.waitForTimeout(300);
  ok((await page.locator('.fnode', { hasText: 'Wait' }).count()) >= 2, 'dragging from the palette drops a node');
  await shot('07-palette');

  ok((await page.locator('.issue-menu summary.bad').count()) === 1, 'unfinished required fields are flagged');
  await page.locator('.issue-menu summary').click();
  await shot('08-issues');
  await page.locator('.issue-menu summary').click();

  // ---- save / enable / reload --------------------------------------------------------------------------
  await page.getByRole('button', { name: /Save changes/ }).click();
  await page.getByText('Saved — changes are live.').waitFor();
  await page.getByRole('button', { name: 'Saved' }).waitFor();
  await page.locator('.switch').click();
  await page.getByText('Flow switched on.').waitFor();
  const url = page.url();
  await page.reload();
  await page.locator('.fnode').first().waitFor();
  await page.waitForTimeout(500);
  ok(page.url() === url, 'URL keeps the flow after reload');
  ok((await page.locator('.fnode', { hasText: '/help' }).count()) === 1, 'edits persisted across reload');
  ok((await page.locator('.out.button').count()) === buttonsBefore + 1, 'added button persisted');
  ok(await page.locator('.switch input').isChecked(), 'enabled state persisted');
  await shot('09-after-reload');

  // ---- manual trigger + live logs -------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'Flows' }).click();
  await page.getByRole('button', { name: '+ New flow' }).click();
  await page.getByRole('button', { name: /Button role panel/ }).click();
  await page.locator('.fnode', { hasText: 'Manual (Run button)' }).waitFor();
  await page.locator('.fnode', { hasText: 'Manual (Run button)' }).click();
  await page.locator('select[aria-label="Pick channel"]').selectOption({ label: '#general' });
  await page.getByRole('button', { name: /Save changes/ }).click();
  await page.getByText('Saved — changes are live.').waitFor();
  await page.locator('.switch').click();
  await page.getByText('Flow switched on.').waitFor();
  await page.locator('.run-btn').click();
  await page.getByText(/Discord ← #general: .*buttons/).waitFor({ timeout: 5000 });
  ok(true, 'Run button executes the flow and the message shows up in the live logs');
  await shot('10-run-logs');

  // ---- unsaved-changes guard ---------------------------------------------------------------------------------
  await page.locator('.flow-name').fill('Renamed panel');
  let asked = false;
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => { asked = true; d.dismiss(); });
  await page.locator('.flow-open', { hasText: 'Support tickets' }).click();
  await page.waitForTimeout(300);
  ok(asked, 'switching flows with unsaved changes asks for confirmation');

  await page.setViewportSize({ width: 820, height: 700 });
  await page.waitForTimeout(300);
  await shot('11-narrow');
  ok(errors.length === 0, `no browser errors (${errors.slice(0, 3).join(' | ')})`);
} catch (err) {
  problems.push(`crashed: ${err.message}`);
  console.error(err);
} finally {
  await browser.close();
  stop();
}
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nAll UI checks passed');
process.exit(problems.length ? 1 : 0);
