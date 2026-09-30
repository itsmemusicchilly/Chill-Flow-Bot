// Browser end-to-end check of the editor against the demo server (real API + fake Discord).
//   npm run e2e                       (needs a Chromium: set CHROMIUM_PATH, or `npx playwright-core install chromium`)
//   SHOTS=./shots npm run e2e         (also saves screenshots)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

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
// benign: the 401 from /api/me before logging in, the deliberate 415 when a fake "picture" is refused, and offline sandboxes blocking Discord's avatar CDN
page.on('console', (m) => { if (m.type() === 'error' && !/401|status of 415|ERR_CERT_AUTHORITY_INVALID|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL/.test(m.text())) errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : null);
// Toasts repeat (the same message can be on screen twice), so wait on the editor's state instead of on their text.
const savedDraft = () => page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
const publishedLive = () => page.locator('.status-chip.live').waitFor();
/** Opens the page editor's "More" menu (Copy link, Responses, Discard changes, Unpublish) if it is closed. */
const openMore = async () => { const d = page.locator('details.more-menu'); if (!(await d.evaluate((e) => e.open))) await d.locator('summary').click(); };
/** Has this <img> really loaded and decoded (a broken picture has no width)? */
const loaded = (locator) => locator.evaluate(async (img) => { try { await img.decode(); } catch { return false; } return img.naturalWidth > 0; });

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
  ok((await page.locator('.fnode').count()) === 9, 'ticket template renders 9 nodes (with the transcript step)');
  ok((await page.locator('.react-flow__edge').count()) === 8, 'ticket template renders 8 connections');
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

  // connecting twice disconnects: dragging from an output to a node connects them, doing it again removes the connection
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(500);
  const edgeCount = () => page.locator('.react-flow__edge').count();
  const edgesBefore = await edgeCount();
  const dragConnection = async () => {
    const from = await page.locator('.fnode', { hasText: 'Slash Command' }).locator('.h-out').first().boundingBox();
    const to = await page.locator('.fnode', { hasText: 'Give Role' }).locator('.h-in').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  await dragConnection();
  ok((await edgeCount()) === edgesBefore + 1, 'dragging from an output to a node connects them');
  await dragConnection();
  ok((await edgeCount()) === edgesBefore, 'dragging the same connection again disconnects them');
  await page.getByText('Connection removed.').waitFor();
  await dragConnection();
  ok((await edgeCount()) === edgesBefore + 1, 'and a third drag connects them again');
  await dragConnection(); // leave the flow as it was

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
  ok(await page.locator('.status-chip.draft').isVisible(), 'a new page is a draft');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await publishedLive();
  const slug = await page.getByLabel('Web address').inputValue();
  ok(await page.locator('.status-chip.live').isVisible(), 'the page can be published');
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
  await openMore();
  await page.getByRole('button', { name: 'Responses' }).click();
  const dialog = page.getByRole('dialog', { name: /Responses/ });
  await dialog.getByText('Demo Visitor').waitFor();
  ok((await dialog.getByText('Mia', { exact: true }).count()) === 1 && (await dialog.getByText('Helper').count()) === 1, 'the response shows up in the dashboard with its answers');
  const csv = await api('GET', `/pages/${pid}/responses.csv?form=form1`);
  ok((await csv.text()).includes('Demo Visitor') && (await csv.text()).includes('Mia'), 'the CSV export contains the response');
  await shot('16-responses');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // =================================================================================================
  // Picture uploads: upload, choose for a page, see it on the public page, delete
  // =================================================================================================
  const bannerPng = await sharp({ create: { width: 300, height: 150, channels: 3, background: '#ff8800' } }).png().toBuffer();
  await page.getByRole('button', { name: 'Pictures' }).click();
  const library = page.getByRole('dialog', { name: 'Pictures' });
  await library.getByText('No pictures yet').waitFor();
  ok(await library.getByText(/BASE_URL/).isVisible(), 'the library explains that pictures in Discord messages need a public BASE_URL');
  await library.getByLabel('Upload pictures').setInputFiles([
    { name: 'banner.png', mimeType: 'image/png', buffer: bannerPng },
    { name: 'sneaky.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>') },
  ]);
  await library.locator('.img-tile', { hasText: 'banner.png' }).waitFor();
  ok(await library.getByText('300×150').isVisible(), 'an uploaded picture appears in the library with its size');
  ok(await library.locator('.upload-progress .error', { hasText: 'sneaky.png' }).isVisible(), 'a file that is not really a picture is refused, with a reason');
  ok((await library.locator('.img-tile').count()) === 1, 'only the real picture was stored');
  ok(await loaded(library.locator('.img-tile img')), 'the library shows the stored picture (served from /i/…)');
  await shot('18-library');
  await library.getByRole('button', { name: 'Close' }).click();

  // choose it for the hero background and for a new image block
  await outline.locator('.block-row', { hasText: 'Hero' }).click();
  const bg = blockInspector.locator('.field', { has: page.locator('label', { hasText: /^Background image$/ }) });
  await bg.getByRole('button', { name: 'Choose…' }).click();
  await page.getByRole('dialog', { name: 'Choose a picture' }).getByRole('button', { name: 'Use banner.png' }).click();
  await bg.getByText('Uploaded picture').waitFor();
  ok(await loaded(bg.locator('img.img-thumb')), 'the chosen picture shows as a thumbnail in the field');
  ok(await loaded(preview.locator('img.hero-bg')), 'the hero background shows in the live preview');
  await outline.locator('.block-add', { hasText: 'Image' }).click();
  const pic = blockInspector.locator('.field', { has: page.locator('label', { hasText: /^Image\b/ }) });
  await pic.getByRole('button', { name: 'Choose…' }).click();
  await page.getByRole('dialog', { name: 'Choose a picture' }).getByRole('button', { name: 'Use banner.png' }).click();
  await blockInspector.getByLabel('Description (for screen readers)').fill('Orange banner');
  ok(await loaded(preview.getByRole('img', { name: 'Orange banner' })), 'an image block shows the uploaded picture in the preview');
  await shot('19-page-with-picture');
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  await page.getByRole('button', { name: 'Publish changes' }).click();
  await publishedLive();

  // visitors get it from this site, with locked-down headers
  await visitorPage.goto(`${BASE}/s/${gid}/${slug}`);
  const heroSrc = await visitorPage.locator('img.hero-bg').getAttribute('src');
  ok(/^\/i\/\d+\/[a-z0-9]{16}\.webp$/.test(heroSrc ?? ''), 'the public page points at /i/<server>/<id>.webp on its own site');
  ok(await loaded(visitorPage.locator('img.hero-bg')) && await loaded(visitorPage.getByRole('img', { name: 'Orange banner' })), 'the pictures load on the public page (allowed by its policy)');
  if (SHOTS) await visitorPage.screenshot({ path: path.join(SHOTS, '20-public-with-picture.png'), fullPage: true });
  const served = await page.request.get(`${BASE}${heroSrc}`);
  ok(served.status() === 200 && served.headers()['content-type'] === 'image/webp' && served.headers()['x-content-type-options'] === 'nosniff' && /sandbox/.test(served.headers()['content-security-policy']), 'the file is served as a WebP with nosniff and a sandboxing policy');

  // usage is shown, and deleting warns about where the picture is used
  await page.getByRole('button', { name: 'Pictures' }).click();
  await library.locator('.img-tile', { hasText: 'banner.png' }).getByText('Used in 1 place').waitFor();
  ok(true, 'the library says where a picture is used');
  const confirms = [];
  const record = (d) => confirms.push(d.message());
  page.on('dialog', record);
  await library.getByRole('button', { name: 'Delete banner.png' }).click();
  await library.getByText('No pictures yet').waitFor();
  page.off('dialog', record);
  ok(confirms.some((m) => /Staff applications/.test(m)), 'deleting a picture warns which page will lose it');
  ok((await page.request.get(`${BASE}${heroSrc}`)).status() === 404, 'a deleted picture is gone from the public address');
  await library.getByRole('button', { name: 'Close' }).click();
  await outline.locator('.block-row', { hasText: 'Hero' }).locator('.badge.bad').waitFor();
  ok(true, 'the page editor flags the block whose picture was deleted');

  // =================================================================================================
  // Draft vs live: edits are private until published
  // =================================================================================================
  const publicUrl = `${BASE}/s/${gid}/${slug}`;
  await outline.locator('.block-row', { hasText: 'Hero' }).click();
  await blockInspector.getByLabel('Title', { exact: true }).fill('Join the team (version 2)');
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  ok(await page.locator('.status-chip.changed').isVisible(), 'after saving, the page says its changes are not live');
  await shot('22-draft-not-live');
  await visitorPage.goto(publicUrl);
  ok(await visitorPage.getByRole('heading', { name: 'Join the Pixel Café team' }).isVisible() && (await visitorPage.getByText('version 2').count()) === 0, 'visitors still see the published version while you edit');
  await page.getByRole('button', { name: 'Publish changes' }).click();
  await publishedLive();
  await visitorPage.reload();
  await visitorPage.getByRole('heading', { name: 'Join the team (version 2)' }).waitFor();
  ok(await page.locator('.status-chip.live').isVisible(), 'publishing makes the change public');
  await blockInspector.getByLabel('Title', { exact: true }).fill('A change I regret');
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  await openMore();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByText('Back to the published version.').waitFor();
  await preview.getByRole('heading', { name: 'Join the team (version 2)' }).waitFor();
  ok(await page.locator('.status-chip.live').isVisible(), 'discarding goes back to the published version');

  // =================================================================================================
  // Link preview: what Discord shows for the page's link
  // =================================================================================================
  await outline.locator('.block-row', { hasText: 'Page settings' }).click();
  const settings = page.getByRole('complementary', { name: 'Page settings' });
  await settings.getByLabel('Description').fill('Apply to join our friendly team');
  await settings.locator('.field', { has: page.locator('label', { hasText: /^Preview picture$/ }) }).getByRole('button', { name: 'Choose…' }).click();
  await page.getByRole('dialog', { name: 'Choose a picture' }).getByLabel('Upload pictures').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: bannerPng });
  await settings.getByText('Uploaded picture').waitFor(); // the new picture is chosen (until then the card may still show the hero's)
  const card = settings.getByLabel('How the link looks in Discord');
  await card.getByText('Apply to join our friendly team').waitFor();
  ok(await loaded(card.locator('img')), 'the card mock shows the description and the chosen picture');
  await card.scrollIntoViewIfNeeded();
  await shot('23-link-preview');
  await page.getByRole('button', { name: /Save changes/ }).click();
  await page.getByRole('button', { name: 'Publish changes' }).click();
  await publishedLive();
  const crawled = await (await page.request.get(publicUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } })).text();
  ok(/property="og:title" content="Staff applications"/.test(crawled) && /property="og:description" content="Apply to join our friendly team"/.test(crawled), 'the public page carries Open Graph title and description for link cards');
  ok(new RegExp(`property="og:image" content="${BASE}/i/${gid}/[a-z0-9]{16}\\.webp"`).test(crawled), 'the card picture is an absolute address on this site');

  // =================================================================================================
  // Who can open the page: members, then roles. Applies as soon as it is saved.
  // =================================================================================================
  await settings.getByLabel('Members of this server').check();
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  const stranger = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  await stranger.goto(publicUrl);
  await stranger.getByRole('heading', { name: 'Log in to continue' }).waitFor();
  const gatePage = await stranger.content();
  ok(!/Join the team|og:title|og:description/.test(gatePage), 'a stranger gets a login prompt and no content, and no link-preview tags');
  if (SHOTS) await stranger.screenshot({ path: path.join(SHOTS, '25-gate.png') });
  await visitorPage.reload();
  await visitorPage.getByRole('heading', { name: 'Join the team (version 2)' }).waitFor();
  ok(true, 'a logged-in member of the server can open a members-only page');

  await settings.getByLabel('Members with one of these roles').check();
  await settings.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  await shot('24-access');
  await visitorPage.reload();
  await visitorPage.getByRole('heading', { name: 'No access' }).waitFor();
  ok(true, 'a member without the chosen role is turned away');
  await settings.getByRole('button', { name: 'Member', exact: true }).click();
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  await visitorPage.reload();
  await visitorPage.getByRole('heading', { name: 'Join the team (version 2)' }).waitFor();
  ok(true, 'having any one of the chosen roles is enough');
  await settings.getByLabel('Anyone with the link').check();
  await page.getByRole('button', { name: /Save changes/ }).click();
  await savedDraft();
  await stranger.reload();
  await stranger.getByRole('heading', { name: 'Join the team (version 2)' }).waitFor();
  ok(true, 'switching back to “anyone” opens the page again');
  await stranger.context().close();

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

  // pictures in message embeds: choose (here: upload) a picture for an embed image, right from the flow editor
  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: /Send Message/ }).click();
  await page.locator('.fnode', { hasText: 'Send Message' }).click();
  await page.getByLabel('Add an embed').check();
  const embedImage = page.locator('.field', { has: page.locator('label', { hasText: /^Image$/ }) });
  await embedImage.getByRole('button', { name: 'Choose…' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a picture' });
  await chooser.getByLabel('Upload pictures').setInputFiles({ name: 'embed.png', mimeType: 'image/png', buffer: bannerPng });
  await embedImage.getByText('Uploaded picture').waitFor();
  ok(await loaded(embedImage.locator('img.img-thumb')), 'uploading from an image field uses the picture straight away (message embeds too)');
  await shot('21-embed-picture');

  // unpublish: the public page disappears
  await page.getByRole('tab', { name: 'Pages' }).click();
  await page.locator('.flow-open', { hasText: 'Staff applications' }).click();
  await openMore();
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await page.getByText('Unpublished. Your draft is still here.').waitFor();
  await visitorPage.goto(`${BASE}/s/${gid}/${slug}`);
  await visitorPage.getByRole('heading', { name: 'Page not found' }).waitFor();
  ok(true, 'unpublishing hides the public page');
  await visitorCtx.close();

  // =================================================================================================
  // Maths: the counter templates and the Math block
  // =================================================================================================
  await page.getByRole('tab', { name: 'Flows' }).click();
  await page.getByRole('button', { name: '+ New flow' }).click();
  await page.getByRole('button', { name: /Member counter channel/ }).waitFor();
  await page.getByRole('button', { name: /Join counter/ }).click();
  await page.locator('.fnode', { hasText: 'Math' }).waitFor();
  await page.waitForTimeout(600);
  ok((await page.locator('.fnode').count()) === 3 && (await page.locator('.react-flow__edge').count()) === 2, 'the Join counter template is Member Joined → Math → Update Channel');
  await page.locator('.fnode', { hasText: 'Math' }).click();
  const math = page.getByRole('complementary', { name: 'Node settings' });
  await math.getByLabel('First value').waitFor();
  ok((await math.getByLabel('Save result as').inputValue()) === 'joins' && (await math.getByLabel('Also remember it').inputValue()) === 'guild', 'the Math block shows what the template set up (result saved as “joins”, remembered on the server)');
  await shot('26-math-block');
  await math.getByLabel('How', { exact: true }).selectOption('formula');
  await math.getByLabel(/^Formula\b/).waitFor(); // (required fields carry a star in their label)
  ok((await math.getByLabel('First value').count()) === 0, 'choosing Formula swaps the two-value fields for one formula field');
  await page.getByRole('tab', { name: 'Nodes' }).click();
  ok(await page.getByRole('button', { name: 'Math', exact: true }).isVisible(), 'the Math block is in the palette');

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
