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
const openMore = async () => { const d = page.locator('.page-editor details.more-menu'); if (!(await d.evaluate((e) => e.open))) await d.locator('summary').click(); };
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

  await page.locator('.fnode', { hasText: 'Save Transcript' }).click();
  const leaveOutText = page.getByLabel('Leave out the plain-text (.txt) copy');
  ok((await leaveOutText.count()) === 1 && !(await leaveOutText.isChecked()), 'Save Transcript attaches a .txt copy by default (the "leave out" box is unticked)');

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

  // a check can ask whether someone has a role (with a role picker), and a node can carry an editor-only title
  const firstCheck = checks.locator('.list-item').first();
  ok((await firstCheck.getByLabel('Value').count()) === 1 && (await firstCheck.getByLabel('Pick role').count()) === 0, 'a text check asks for a value to compare, not for a role');
  await firstCheck.getByLabel('Check', { exact: true }).selectOption('hasRole');
  await firstCheck.getByLabel('Pick role').waitFor();
  ok((await firstCheck.getByLabel('Value').count()) === 0 && (await firstCheck.getByLabel('Compare to').count()) === 0, 'choosing “has the role” swaps the value fields for a role picker');
  await firstCheck.getByLabel('Pick role').selectOption({ label: '@Staff' });
  await page.locator('.fnode', { hasText: 'has role Staff' }).waitFor();
  ok((await firstCheck.locator('.list-title').textContent()).includes('has role Staff'), 'the check\'s heading in the list uses the role\'s name too');
  ok(true, 'the node shows the check in words, with the role’s name (has role Staff)');
  ok((await firstCheck.getByText('Someone who is not in the server does not have the role.').count()) === 1, 'the optional Member field explains what happens to someone who left');
  const titleBox = page.getByLabel(/^Title\b/);
  ok((await titleBox.inputValue()) === '' && (await titleBox.getAttribute('placeholder')) === 'Condition (If)', 'every node has an optional title, empty at first (the placeholder is the node’s own name)');
  await titleBox.fill('Is staff?');
  await page.locator('.fnode .fnode-title', { hasText: 'Is staff?' }).waitFor();
  ok((await page.locator('.fnode .fnode-kind', { hasText: 'Condition (If)' }).count()) === 1, 'a titled node shows its title, with what kind of node it is underneath');
  await shot('29-role-check-and-title');

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
  ok((await page.locator('.fnode .fnode-title', { hasText: 'Is staff?' }).count()) === 1 && (await page.locator('.fnode', { hasText: 'has role Staff' }).count()) === 1, 'the title and the role check are still there after reload');
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

  // =================================================================================================
  // Schedules: every …, at a set time, cron — with a time zone and a preview of the next runs
  // =================================================================================================
  await page.getByRole('button', { name: /Schedule/ }).click();
  await page.locator('.fnode', { hasText: 'every 60 minutes' }).waitFor();
  const sched = page.getByRole('complementary', { name: 'Node settings' });
  const nextRunsList = sched.locator('.schedule-preview');
  ok((await sched.getByLabel('Run', { exact: true }).inputValue()) === 'every' && (await sched.getByLabel(/^Every\b/).count()) === 1, 'a new Schedule starts as “Every … minutes”, as before');
  ok((await sched.getByLabel('Time', { exact: true }).count()) === 0 && (await sched.getByLabel('Cron expression').count()) === 0, 'the time and cron fields are hidden until chosen');

  await sched.getByLabel('Run', { exact: true }).selectOption('time');
  await sched.getByLabel('Time', { exact: true }).waitFor();
  ok((await sched.getByLabel(/^Every\b/).count()) === 0, 'choosing “At a set time” swaps the interval fields for a time, weekdays and a time zone');
  const zone = sched.getByLabel('Time zone');
  ok(await zone.evaluate((el) => el.value !== '' && [...el.options].some((o) => o.value === el.value)), 'a new schedule starts on a real time zone (the one of the browser)');
  await sched.getByLabel('Time', { exact: true }).fill('18:30');
  await sched.getByRole('group', { name: 'Only on these days' }).getByRole('button', { name: 'Mon', exact: true }).click();
  await sched.getByRole('group', { name: 'Only on these days' }).getByRole('button', { name: 'Fri', exact: true }).click();
  await zone.selectOption('Asia/Kuala_Lumpur');
  await page.locator('.fnode', { hasText: 'Mon, Fri at 18:30 (Asia/Kuala_Lumpur)' }).waitFor();
  await nextRunsList.locator('li').first().waitFor();
  const runs = await nextRunsList.locator('li').allTextContents();
  ok(runs.length === 5 && runs.every((t) => /^(Mon|Fri) \d{1,2} \w{3} \d{4}, 18:30$/.test(t)), `the preview lists the next five runs, on Mondays and Fridays at 18:30 (${runs[0]})`);
  ok((await nextRunsList.textContent()).includes('(Asia/Kuala_Lumpur)'), 'and says which time zone they are read in');
  ok((await zone.locator('option[value="Asia/Kolkata"]').count()) === 1 && (await zone.locator('option[value="Asia/Calcutta"]').count()) === 0, 'India is offered as Asia/Kolkata');
  await nextRunsList.scrollIntoViewIfNeeded();
  await shot('27-schedule-time');

  await sched.getByLabel('Run', { exact: true }).selectOption('cron');
  await sched.getByLabel('Cron expression').waitFor();
  await sched.getByLabel('Cron expression').fill('nope');
  await sched.getByText(/A cron expression has 5 fields/).waitFor();
  ok((await nextRunsList.count()) === 0, 'a cron expression that cannot work is explained in words, and nothing is previewed');
  await sched.getByLabel('Cron expression').fill('0 0 31 2 *');
  await sched.getByText(/This schedule never runs/).waitFor();
  await sched.getByLabel('Cron expression').fill('*/15 * * * *');
  await nextRunsList.locator('li').first().waitFor();
  const quarter = await nextRunsList.locator('li').allTextContents();
  ok(quarter.length === 5 && quarter.every((t) => /:(00|15|30|45)$/.test(t)), `cron */15 previews quarter-hour runs (${quarter[0]})`);
  await page.locator('.fnode', { hasText: 'cron */15 * * * * (Asia/Kuala_Lumpur)' }).waitFor();
  await nextRunsList.scrollIntoViewIfNeeded();
  await shot('28-schedule-cron');

  await sched.getByLabel('Run', { exact: true }).selectOption('every');
  await sched.getByText(/Counts from when the flow is saved/).waitFor();
  ok((await sched.getByLabel(/^Every\b/).count()) === 1 && (await sched.getByLabel('Cron expression').count()) === 0, 'and back to “Every …” hides the cron field again');


  // =================================================================================================
  // Alerts from other platforms: starter flows, the webhook address, feed sources, and platforms the operator has not set up
  // =================================================================================================
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await page.getByRole('tab', { name: 'Flows' }).click();
  await page.getByRole('button', { name: '+ New flow' }).click();
  for (const name of [/YouTube upload announcer/, /Post announcer/, /Twitch live alert/, /YouTube subscriber milestone/, /Webhook alert/]) await page.getByRole('button', { name }).waitFor();
  ok(true, 'the five alert starter flows are in the template list');
  await page.getByRole('button', { name: /Webhook alert/ }).click();
  await page.locator('.fnode', { hasText: 'Webhook Received' }).waitFor();
  await page.locator('.fnode', { hasText: 'Webhook Received' }).click();
  const hookPanel = page.getByRole('complementary', { name: 'Node settings' });
  await hookPanel.locator('#webhook-url').waitFor();
  const hookUrl = await hookPanel.locator('#webhook-url').inputValue();
  ok(new RegExp(`^${BASE.replace(/[.]/g, '\\.')}/hooks/[A-Za-z0-9_-]{43}$`).test(hookUrl), 'a saved Webhook Received trigger shows its secret address');
  ok((await hookPanel.locator('#webhook-url').getAttribute('readonly')) !== null, 'the address is read-only');
  await hookPanel.getByRole('button', { name: 'Copy' }).click();
  ok((await page.evaluate(() => navigator.clipboard.readText())) === hookUrl, 'Copy puts the address on the clipboard');
  await shot('36-webhook-panel');
  const call = (url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":"hi"}' }).then((r) => r.status);
  ok((await call(hookUrl)) === 409, 'the address is live (a flow that is switched off answers 409)');
  await hookPanel.getByRole('button', { name: 'Make a new address' }).click();
  await page.waitForFunction((old) => document.querySelector('#webhook-url') && document.querySelector('#webhook-url').value !== old, hookUrl);
  const newUrl = await hookPanel.locator('#webhook-url').inputValue();
  ok(newUrl !== hookUrl && (await call(hookUrl)) === 404 && (await call(newUrl)) === 409, 'Make a new address: the old one stops working at once, the new one works');

  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: /New Feed Item/ }).click();
  await page.locator('.fnode', { hasText: 'New Feed Item' }).waitFor();
  const feed = page.getByRole('complementary', { name: 'Node settings' });
  await feed.getByLabel('Where').waitFor();
  ok(await feed.getByLabel('YouTube channel ID').isVisible() && (await feed.getByLabel(/^Feed address/).count()) === 0, 'New Feed Item starts on YouTube and asks for a channel ID');
  await feed.getByLabel('YouTube channel ID').fill(`UC${'a'.repeat(22)}`);
  await feed.locator('.feed-url').waitFor();
  ok((await feed.locator('.feed-url').textContent()) === `https://www.youtube.com/feeds/videos.xml?channel_id=UC${'a'.repeat(22)}`, 'it shows the exact address the bot will read');
  await feed.getByLabel('Where').selectOption('url');
  for (const [typed, message] of [['http://blog.example.com/feed.xml', /Only https/], ['https://localhost/feed', /not a public website name/], ['https://127.0.0.1/x', /raw IP/], ['https://user:pw@blog.example.com/x', /user name or password/]]) {
    await feed.getByLabel(/^Feed address/).fill(typed);
    await feed.getByText(message).waitFor();
    ok((await feed.locator('.feed-url').count()) === 0, `${typed} is refused in words, and no address is previewed`);
  }
  await feed.getByLabel(/^Feed address/).fill('https://blog.example.com/feed.xml');
  await feed.locator('.feed-url').waitFor();
  await page.locator('.fnode', { hasText: 'blog.example.com/feed.xml' }).waitFor();
  ok((await feed.locator('.issues .error').count()) === 0, 'a public https address is accepted, and the node shows what it watches');
  await feed.getByLabel(/^Check every/).fill('1');
  await feed.getByText(/must be between 5 and/).waitFor();
  ok(true, 'checking more often than every 5 minutes is refused');
  await feed.getByLabel(/^Check every/).fill('30');
  await feed.getByLabel('Where').selectOption('reddit');
  await feed.getByLabel('Subreddit').fill('r/gaming');
  ok((await feed.locator('.feed-url').textContent()) === 'https://www.reddit.com/r/gaming/new/.rss', 'Reddit: r/gaming becomes the subreddit\'s feed address');
  await feed.getByLabel('Where').selectOption('bluesky');
  await feed.getByLabel('Bluesky handle').fill('@alice.bsky.social');
  ok((await feed.locator('.feed-url').textContent()) === 'https://bsky.app/profile/alice.bsky.social/rss', 'Bluesky: a handle becomes its feed address');
  await feed.locator('.feed-url').scrollIntoViewIfNeeded();
  await shot('37-feed-inspector');

  await page.getByRole('tab', { name: 'Nodes' }).click();
  const ytItem = page.getByRole('button', { name: /YouTube Subscribers/ });
  const twItem = page.getByRole('button', { name: /Twitch Channel Live/ });
  ok(!(await ytItem.evaluate((el) => el.classList.contains('blocked'))) && (await twItem.evaluate((el) => el.classList.contains('blocked'))), 'the palette locks Twitch (the demo operator has no Twitch application) but not YouTube (it has a key)');
  await twItem.click();
  await page.locator('.fnode', { hasText: 'Twitch Channel Live' }).waitFor();
  await feed.getByText(/needs a Twitch application/).waitFor();
  ok(true, 'a Twitch node says the bot operator has not set that up, and that it will not run');
  await shot('38-not-set-up');
  await page.getByRole('tab', { name: 'Nodes' }).click();
  await ytItem.click();
  await page.locator('.fnode', { hasText: 'YouTube Subscribers' }).waitFor();
  ok((await feed.getByText(/needs a YouTube API key/).count()) === 0 && (await feed.getByLabel(/^Announce every/).inputValue()) === '1000', 'a YouTube Subscribers node has no such warning, and starts at every 1,000');

  // =================================================================================================
  // Change Buttons (a message that was already sent), and the Channel scope of remembered variables
  // =================================================================================================
  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: /Change Buttons/ }).click();
  const cbNode = page.locator('[data-testid="node-action.message.buttons"]');
  await cbNode.waitFor();
  const cb = page.getByRole('complementary', { name: 'Node settings' });
  const mode = cb.getByLabel('What to do', { exact: true });
  await mode.waitFor();
  ok((await mode.inputValue()) === 'add' && (await cb.getByRole('button', { name: '+ Add' }).isVisible()), 'a new Change Buttons node starts on “Add or update buttons”, with a list to add to');
  ok((await cbNode.locator('.out.button').count()) === 0, 'it has no button outputs until a button is added');
  await cb.getByRole('button', { name: '+ Add' }).click();
  await cb.getByRole('button', { name: '+ Add' }).click();
  ok((await cbNode.locator('.out.button').count()) === 2, 'each button added gets its own output on the node');
  await cb.locator('input[placeholder="open_ticket"]').first().fill('close_ticket');
  ok((await cbNode.locator('.out.button').count()) === 1, 'giving a button a Button ID takes its output away (a Button Clicked trigger answers it instead)');
  await shot('39-change-buttons');

  await mode.selectOption('remove');
  await page.waitForTimeout(250);
  ok((await cbNode.locator('.out.button').count()) === 0, 'in “Remove” mode the button outputs are gone');
  ok((await cbNode.locator('.badge.bad').count()) === 1, 'removing needs at least one button named — the node is flagged until one is');
  await cb.getByRole('button', { name: '+ Add' }).click();
  await cb.getByPlaceholder('open_ticket or Close').fill('Close');
  await page.waitForTimeout(250);
  ok((await cbNode.locator('.badge.bad').count()) === 0, 'naming a button clears the flag');
  await mode.selectOption('clear');
  await page.waitForTimeout(250);
  ok((await cb.getByRole('button', { name: '+ Add' }).count()) === 0, '“Remove all buttons” has no lists to fill in');
  await mode.selectOption('disable');
  await page.waitForTimeout(250);
  ok((await cb.getByRole('button', { name: '+ Add' }).isVisible()) && (await cbNode.locator('.badge.bad').count()) === 0, '“Disable” accepts an empty list (it then means every button)');
  await mode.selectOption('delete');
  await page.waitForTimeout(250);
  ok((await cb.getByRole('button', { name: '+ Add' }).count()) === 0 && (await cbNode.locator('.badge.bad').count()) === 0 && (await cbNode.getByText('delete the message').count()) === 1, '“Delete the message” needs no list, and the node says what it will do');

  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: /Set Variable/ }).click();
  const setVar = page.getByRole('complementary', { name: 'Node settings' });
  const scope = setVar.getByLabel('Where to store it');
  await scope.waitFor();
  ok((await scope.locator('option', { hasText: 'Channel (remembered)' }).count()) === 1, 'Set Variable offers the Channel scope');
  ok((await setVar.getByPlaceholder('blank = the channel where this happened').count()) === 0, 'and asks which channel only once that scope is chosen');
  await scope.selectOption('channel');
  ok(await setVar.getByPlaceholder('blank = the channel where this happened').isVisible(), 'choosing it shows an optional Channel field (blank = where the flow runs)');
  await shot('40-channel-variable');

  await page.setViewportSize({ width: 820, height: 700 });
  await page.waitForTimeout(300);
  await shot('11-narrow');
  ok(errors.length === 0, `no browser errors (${errors.slice(0, 3).join(' | ')})`);

  // =================================================================================================
  // Phones: a 390×844 touch device with its own login. Nothing scrolls sideways, the sidebar is a drawer,
  // the node settings a bottom sheet, the page builder three panes, and the controls are big enough to tap.
  // =================================================================================================
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await phoneCtx.newPage();
  const phoneErrors = [];
  phone.on('pageerror', (e) => phoneErrors.push(`pageerror: ${e.message}`));
  phone.on('dialog', (d) => d.accept());
  const phoneShot = (name) => (SHOTS ? phone.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : null);
  const fits = async (what) => ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `phone: ${what} does not scroll sideways`);
  const inView = async (locator) => { const b = await locator.boundingBox(); return Boolean(b) && b.x >= -1 && b.y >= -1 && b.x + b.width <= 391 && b.y + b.height <= 845; };

  await phone.goto(`${BASE}/demo-login`);
  await phone.getByRole('heading', { name: 'Choose a server' }).waitFor();
  await fits('the server picker');
  await phone.getByRole('button', { name: /Pixel Café/ }).click();
  await phone.locator('.topbar').waitFor();
  ok(await phone.locator('.sidebar.open').isVisible(), 'phone: with nothing open, the flow list is what you see first (the sidebar drawer starts open)');
  await fits('the flow list');
  await phoneShot('30-phone-drawer');
  const flowRows = phone.locator('.flow-item');
  ok((await flowRows.count()) > 0 && await flowRows.first().getByRole('button', { name: /^Duplicate/ }).isVisible(), 'phone: a flow\'s Duplicate and Delete buttons are always visible (there is no hover on a touch screen)');

  await phone.locator('.flow-open').first().tap();
  await phone.locator('.fnode').first().waitFor();
  ok((await phone.locator('.sidebar.open').count()) === 0, 'phone: picking a flow closes the drawer');
  ok(await phone.locator('.react-flow').isVisible() && (await phone.locator('.react-flow__minimap').count()) === 0, 'phone: the canvas has the whole screen (no minimap)');
  await fits('a flow');
  await phoneShot('31-phone-flow');
  const first = phone.locator('.fnode').first();
  await first.scrollIntoViewIfNeeded();
  await first.tap();
  const sheet = phone.getByRole('complementary', { name: 'Node settings' });
  await sheet.waitFor();
  const sb = await sheet.boundingBox();
  ok(sb.width >= 389 && sb.y > 250 && Math.round(sb.y + sb.height) >= 843, 'phone: tapping a node opens its settings as a bottom sheet, leaving the canvas above it');
  await fits('the node settings sheet');
  await phoneShot('32-phone-node-settings');
  await sheet.getByRole('button', { name: 'Close settings' }).tap();
  await phone.getByRole('complementary', { name: 'Node settings' }).waitFor({ state: 'detached' });
  ok(true, 'phone: the sheet has a ✕ that closes it');

  const targets = await phone.evaluate(() => Object.fromEntries(['.nav-toggle', '.topbar .icon-btn[aria-label="Back to servers"]', '.flowbar .btn.primary'].map((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [sel, Math.round(Math.min(r.width, r.height))]; })));
  ok(Object.values(targets).every((n) => n >= 40), `phone: the main buttons are at least 40 px to tap (${JSON.stringify(targets)})`);
  ok(await phone.locator('.flow-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 16), 'phone: text fields are 16 px, so iOS does not zoom the page when one is focused');

  await phone.locator('summary[aria-label="More actions"]').tap();
  await phone.getByRole('button', { name: 'Variables' }).waitFor();
  ok(await inView(phone.locator('.topbar .more-panel')), 'phone: the ⋯ menu holds Variables, Pictures, logs and Log out, inside the screen');
  await phone.getByRole('button', { name: 'Variables' }).tap();
  const dlg = phone.getByRole('dialog', { name: 'Variables' });
  await dlg.waitFor();
  ok(await inView(dlg), 'phone: a dialog fits the screen');
  await fits('a dialog');
  await phoneShot('33-phone-dialog');
  await dlg.getByRole('button', { name: 'Close' }).tap();

  await phone.getByRole('button', { name: 'Flows, pages and nodes' }).tap();
  await phone.getByRole('tab', { name: 'Pages' }).tap();
  await phone.locator('.flow-open').first().tap();
  await phone.locator('.pane-tabs').waitFor();
  ok(await phone.locator('.outline').isVisible() && !(await phone.locator('.preview-wrap').isVisible()) && !(await phone.locator('.page-inspector').isVisible()), 'phone: the page builder shows one pane at a time, starting with the blocks');
  await fits('the page builder (blocks)');
  await phoneShot('34-phone-page-blocks');
  await phone.locator('.pane-tabs').getByRole('tab', { name: 'Preview' }).tap();
  await phone.locator('.preview').waitFor();
  ok(!(await phone.locator('.outline').isVisible()) && await inView(phone.locator('.preview')), 'phone: the Preview tab gives the live preview the whole screen');
  await fits('the page preview');
  await phone.locator('.pane-tabs').getByRole('tab', { name: 'Blocks' }).tap();
  await phone.locator('.block-item .block-row').first().tap();
  await phone.locator('.page-inspector').waitFor();
  ok(!(await phone.locator('.outline').isVisible()) && (await phone.locator('.pane-tabs [aria-selected="true"]').textContent()).includes('settings'), 'phone: tapping a block jumps to its settings');
  await fits('a block\'s settings');
  await phoneShot('35-phone-block-settings');

  // alert triggers on a phone: the long secret address and feed address stay inside the screen
  await phone.getByRole('button', { name: 'Flows, pages and nodes' }).tap();
  await phone.getByRole('tab', { name: 'Flows' }).tap();
  await phone.locator('.flow-item', { hasText: 'Webhook alert' }).locator('.flow-open').tap();
  await phone.locator('.fnode', { hasText: 'Webhook Received' }).waitFor();
  await phone.locator('.fnode', { hasText: 'Webhook Received' }).scrollIntoViewIfNeeded();
  await phone.locator('.fnode', { hasText: 'Webhook Received' }).tap();
  const hookSheet = phone.getByRole('complementary', { name: 'Node settings' });
  await hookSheet.locator('#webhook-url').waitFor();
  await fits('the webhook settings');
  const hookBox = await hookSheet.locator('#webhook-url').boundingBox();
  ok(hookBox.x >= 0 && hookBox.x + hookBox.width <= 391, 'phone: the secret address box fits the screen');
  await phoneShot('36-phone-webhook');
  await hookSheet.getByRole('button', { name: 'Close settings' }).tap();
  await phone.getByRole('button', { name: 'Flows, pages and nodes' }).tap();
  await phone.getByRole('tab', { name: 'Nodes' }).tap();
  await phone.getByRole('button', { name: /New Feed Item/ }).tap();
  const phoneFeed = phone.getByRole('complementary', { name: 'Node settings' });
  await phoneFeed.getByLabel('Where').waitFor();
  await phoneFeed.getByLabel('Where').selectOption('url');
  await phoneFeed.getByLabel(/^Feed address/).fill(`https://a-very-long-website-name.example.com/${'section/'.repeat(12)}feed.xml`);
  await phoneFeed.locator('.feed-url').waitFor();
  await fits('the feed settings with a long address');
  await phoneShot('37-phone-feed');
  await phoneCtx.close();
  ok(phoneErrors.length === 0, `phone: no browser errors (${phoneErrors.slice(0, 3).join(' | ')})`);
} catch (err) {
  problems.push(`crashed: ${err.message}`);
  console.error(err);
} finally {
  await browser.close();
  stop();
}
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nAll UI checks passed');
process.exit(problems.length ? 1 : 0);
