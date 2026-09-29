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

  // no artificial list caps: an If node takes more than the old limit of 10 checks
  await page.getByRole('button', { name: /Condition \(If\)/ }).click();
  const checks = page.locator('.field', { has: page.locator('label', { hasText: /^Checks$/ }) });
  for (let i = 0; i < 12; i += 1) await checks.getByRole('button', { name: '+ Add' }).click();
  ok((await checks.locator('.list-item').count()) === 12, 'an If node accepts 12 checks (no artificial cap)');
  ok(await checks.getByRole('button', { name: '+ Add' }).isEnabled(), '+ Add is still available after 12 checks');

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
  ok(await page.getByText('2 flows', { exact: true }).isVisible(), 'the flow counter shows a plain count (no "/25")');
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

  // =================================================================================================
  // Website builder: build a page, publish it, submit its form as a visitor, review the response
  // =================================================================================================
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.accept()); // discard the unsaved flow rename from the previous step
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'Pages' }).click();
  await page.getByRole('button', { name: '+ New page' }).click();
  await page.getByRole('button', { name: /Staff application form/ }).click();
  const outline = page.getByRole('complementary', { name: 'Blocks' });
  await outline.locator('.block-row', { hasText: 'Hero' }).waitFor();
  const pageUrlMatch = page.url().match(/#\/g\/(\d+)\/p\/([\w-]+)/);
  ok(Boolean(pageUrlMatch), 'creating a page opens it (URL has the page id)');
  const [, gid, pid] = pageUrlMatch;
  const preview = page.frameLocator('iframe[title="Page preview"]');
  await preview.getByRole('heading', { name: 'Join our team' }).waitFor();
  ok(true, 'the live preview shows the template');
  await shot('12-page-editor');

  // edit a block: the preview follows as you type
  await outline.locator('.block-row', { hasText: 'Hero' }).click();
  const blockInspector = page.getByRole('complementary', { name: 'Block settings' });
  await blockInspector.getByLabel('Title', { exact: true }).fill('Join the Pixel Café team');
  await preview.getByRole('heading', { name: 'Join the Pixel Café team' }).waitFor({ timeout: 5000 });
  ok(true, 'editing a block updates the preview live');

  // add blocks; the text block carries an XSS payload that must stay inert
  await outline.locator('.block-add', { hasText: 'Text' }).click();
  await blockInspector.getByLabel(/^Text\b/).fill('Hello <img src=x onerror="window.__pwned=1"> **bold** and [a link](javascript:alert(1))');
  await preview.locator('strong', { hasText: 'bold' }).waitFor();
  ok((await preview.locator('img').count()) === 0, 'HTML typed into a text block is shown as text in the preview, not run');
  const blocksBefore = await outline.locator('.block-item').count();
  await outline.locator('.block-add', { hasText: 'Divider' }).click();
  ok((await outline.locator('.block-item').count()) === blocksBefore + 1, 'adding a block adds it to the outline');
  await page.getByRole('button', { name: /Save changes/ }).click();
  await page.getByText('Saved.', { exact: true }).waitFor();
  await page.locator('.switch').click();
  await page.getByText('Published — anyone with the link can see it.').waitFor();
  const slug = await page.getByLabel('Web address').inputValue();
  ok(await page.locator('.switch input').isChecked(), 'the page can be published');
  await shot('13-page-published');

  // a flow that reacts to the form (created through the API; the trigger picker is checked in the UI below)
  const api = (method, url, data) => page.request.fetch(`${BASE}/api/guilds/${gid}${url}`, { method, headers: { Origin: BASE }, data });
  const flowRes = await api('POST', '/flows', {
    name: 'Application alert',
    graph: {
      nodes: [
        { id: 't1', type: 'trigger.form.submitted', position: { x: 0, y: 0 }, data: { form: `${pid}:form1` } },
        { id: 'l1', type: 'logic.log', position: { x: 340, y: 0 }, data: { message: 'APPLICATION from {{user.name}}: {{form.name}} wants {{form.role}}' } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'out', target: 'l1' }],
    },
  });
  const flowId = (await flowRes.json()).flow.id;
  await api('PUT', `/flows/${flowId}`, { enabled: true });

  // a visitor logs in and fills the form (in a separate browser session)
  const visitorCtx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const visitorPage = await visitorCtx.newPage();
  const vErrors = [];
  visitorPage.on('pageerror', (e) => vErrors.push(`pageerror: ${e.message}`));
  // 422 is the deliberate "please fix your answers" response of the invalid submit above
  visitorPage.on('console', (m) => { if (m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|status of 422/.test(m.text())) vErrors.push(`console: ${m.text()}`); });
  await visitorPage.goto(`${BASE}/s/${gid}/${slug}`);
  await visitorPage.getByRole('link', { name: 'Log in with Discord' }).waitFor();
  ok(await visitorPage.getByRole('heading', { name: 'Join the Pixel Café team' }).isVisible(), 'the public page is served');
  ok((await visitorPage.locator('img[src="x"]').count()) === 0 && (await visitorPage.evaluate(() => window.__pwned)) === undefined, 'the XSS payload did nothing on the public page');
  ok(await visitorPage.getByText('not made or endorsed by Discord').isVisible(), 'the anti-phishing footer is shown');
  await visitorPage.goto(`${BASE}/demo-visitor-login?next=${encodeURIComponent(`/s/${gid}/${slug}`)}`);
  await visitorPage.getByLabel(/What should we call you/).waitFor();
  ok(await visitorPage.getByText('Signed in as').isVisible(), 'a logged-in visitor sees the form');
  if (SHOTS) await visitorPage.screenshot({ path: path.join(SHOTS, '14-public-page.png'), fullPage: true });
  await visitorPage.getByLabel(/What should we call you/).fill('Mia');
  await visitorPage.getByLabel(/How old are you/).fill('21');
  await visitorPage.getByLabel(/Which role/).selectOption('Helper');
  await visitorPage.getByLabel(/Why do you want/).fill('too short');
  await visitorPage.getByLabel(/I have read and agree/).check();
  // the browser would stop a too-short answer itself (minlength); switch that off to prove the SERVER checks too
  await visitorPage.evaluate(() => { document.querySelector('form[action*="/f/"]').noValidate = true; });
  await visitorPage.getByRole('button', { name: 'Send application' }).click();
  await visitorPage.waitForLoadState('load');
  if (SHOTS) await visitorPage.screenshot({ path: path.join(SHOTS, '14b-visitor-after-invalid-submit.png'), fullPage: true });
  await visitorPage.getByText('Write at least 30 characters.').waitFor({ timeout: 8000 });
  ok((await visitorPage.getByLabel(/What should we call you/).inputValue()) === 'Mia', 'validation errors keep what was typed');
  await visitorPage.getByLabel(/Why do you want/).fill('I have helped run community events for three years and enjoy welcoming people.');
  await visitorPage.getByLabel(/I have read and agree/).check();
  await visitorPage.getByRole('button', { name: 'Send application' }).click();
  await visitorPage.getByText('Thanks — we will get back to you on Discord.').waitFor();
  if (SHOTS) await visitorPage.screenshot({ path: path.join(SHOTS, '15-thanks.png'), fullPage: true });
  ok(true, 'submitting shows the thank-you message');
  await visitorPage.goto(`${BASE}/s/${gid}/${slug}`);
  await visitorPage.getByText('already sent a response').waitFor();
  ok(true, 'one response per person is enforced');
  if (SHOTS) await visitorPage.screenshot({ path: path.join(SHOTS, '15-already-sent.png'), fullPage: true });
  ok(vErrors.length === 0, `no browser errors on the public pages (${vErrors.slice(0, 3).join(' | ')})`);

  // back in the dashboard: the flow ran and the response is there
  await page.getByText(/APPLICATION from Demo Visitor: Mia wants Helper/).waitFor({ timeout: 8000 });
  ok(true, 'the “Form Submitted” flow ran with the answers');
  await page.getByRole('button', { name: 'Responses' }).click();
  const dialog = page.getByRole('dialog', { name: /Responses/ });
  await dialog.getByText('Demo Visitor').waitFor();
  ok((await dialog.getByText('Mia', { exact: true }).count()) === 1 && (await dialog.getByText('Helper').count()) === 1, 'the response shows up in the dashboard with its answers');
  const csv = await api('GET', `/pages/${pid}/responses.csv?form=form1`);
  ok((await csv.text()).includes('Demo Visitor') && (await csv.text()).includes('Mia'), 'the CSV export contains the response');
  await shot('16-responses');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // the flow's trigger lists the form, by name (the flow was created behind the editor's back, so reload to see it)
  await page.reload();
  await page.getByRole('tab', { name: 'Flows' }).click();
  await page.locator('.flow-open', { hasText: 'Application alert' }).click();
  await page.locator('.fnode', { hasText: 'Form Submitted' }).click();
  await page.getByText(/→ .*Application/).waitFor();
  ok(true, 'the trigger’s form picker shows the form by name');
  await page.locator('.fnode', { hasText: 'Log' }).click();
  await page.locator('summary', { hasText: /Variables you can use/ }).click();
  ok(await page.getByRole('button', { name: '{{form.name}}' }).isVisible(), 'the form’s questions are offered as variables');
  await shot('17-form-trigger');

  // unpublish: the public page disappears
  await page.getByRole('tab', { name: 'Pages' }).click();
  await page.locator('.flow-open', { hasText: 'Staff applications' }).click();
  await page.locator('.switch').click();
  await page.getByText('Unpublished.').waitFor();
  await visitorPage.goto(`${BASE}/s/${gid}/${slug}`);
  await visitorPage.getByRole('heading', { name: 'Page not found' }).waitFor();
  ok(true, 'unpublishing hides the public page');
  await visitorCtx.close();

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
