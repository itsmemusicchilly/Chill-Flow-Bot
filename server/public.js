// The public website: /s/<serverId>/<slug>. The only unauthenticated surface of the app, so it is deliberately small:
// pages are rendered from structured data by shared/render-page.js (no script, strict CSP), forms need a Discord login,
// every submission is CSRF-protected, same-origin, rate-limited and validated on the server.
import express from 'express';
import { BLOCK_ID_RE, SLUG_RE } from '../shared/blocks.js';
import { summarize, validateSubmission } from '../shared/forms.js';
import { isCapped, LIMITS } from '../shared/limits.js';
import { renderNotFound, renderNotice, renderPage } from '../shared/render-page.js';
import { safeUrl } from '../shared/urls.js';
import { uid } from '../shared/util.js';
import { friendlyError } from './engine/errors.js';
import { RateLimiter } from './engine/rate-limit.js';

const GID_RE = /^\d{5,25}$/;
// No script at all, images only over https or from this site's own uploads, forms may only post back to this site.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const visitorUser = (v) => ({
  id: v.id, username: v.name, globalName: v.name, bot: false,
  displayAvatarURL: () => (v.avatar ? `https://cdn.discordapp.com/avatars/${v.id}/${v.avatar}.png?size=64` : ''),
});

export function createPublic({ config, db, runtime, bot, logger, auth }) {
  const router = express.Router();
  // Always-on protection of the site itself (like the login limiter); not a policy cap on what flows can do.
  const rate = { views: 600, visitor: 10, ip: 60, ...config.publicRate }; // `publicRate` exists only so tests can tune this
  const views = new RateLimiter(rate.views, 60_000);
  const submitsByVisitor = new RateLimiter(rate.visitor, 60_000);
  const submitsByIp = new RateLimiter(rate.ip, 60_000);
  const parseForm = express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 1000 });

  router.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      // NOT "no-referrer": with it browsers send `Origin: null` on same-origin form POSTs, which our CSRF origin check must refuse.
      // "same-origin" still sends nothing to other sites.
      'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
    });
    next();
  });
  router.use(auth.attachVisitor);
  router.use((req, res, next) => (views.take(req.ip) ? next() : res.status(429).type('text/plain').send('Too many requests. Please slow down.')));

  const html = (res, status, body) => res.status(status).type('html').send(body);
  const notFound = (res) => html(res, 404, renderNotFound()); // identical for unknown, unpublished and other-server pages

  /** /:gid/:slug → a *published* page of a server the bot is in, or null. */
  function lookup(req) {
    const { gid, slug } = req.params;
    if (!GID_RE.test(gid) || !SLUG_RE.test(slug) || !bot.hasGuild(gid)) return null;
    const page = db.getPageBySlug(gid, slug);
    return page?.published ? page : null;
  }
  const findForm = (page, blockId) => (BLOCK_ID_RE.test(blockId) ? page.blocks.find((b) => b.id === blockId && b.type === 'form') : undefined);
  const pathOf = (page) => `/s/${page.guildId}/${page.slug}`;
  const cooldownMs = (d) => (Number(d.cooldownMinutes) > 0 ? Number(d.cooldownMinutes) * 60_000 : 0);

  /** Checks that only need our own database. Kept synchronous so "check, then insert" cannot be interleaved by another request. */
  function dbGate(page, block, visitorId) {
    const d = block.data;
    if (d.oneResponsePerUser && db.lastResponseAt(page.guildId, page.id, block.id, visitorId) !== undefined) return { blocked: 'already' };
    const wait = cooldownMs(d);
    if (wait) {
      const last = db.lastResponseAt(page.guildId, page.id, block.id, visitorId);
      if (last !== undefined && Date.now() - last < wait) return { blocked: 'cooldown' };
    }
    if (isCapped(LIMITS.responsesPerGuild) && db.countResponsesInGuild(page.guildId) >= LIMITS.responsesPerGuild) return { blocked: 'full' };
    return null;
  }

  /** What each form should show this visitor (login prompt, "members only", "already sent", …). */
  async function gates(page, visitor, member) {
    const out = {};
    for (const b of page.blocks) {
      if (b.type !== 'form' || !visitor) continue;
      const blocked = b.data.requireMember && !member ? { blocked: 'member' } : dbGate(page, b, visitor.id);
      if (blocked) out[b.id] = blocked;
    }
    return out;
  }

  async function sendPage(req, res, page, { status = 200, overrides = {}, member } = {}) {
    const guild = bot.guildSummary(page.guildId);
    const needMember = page.blocks.some((b) => b.type === 'form' && b.data.requireMember);
    const who = req.visitor ? (member !== undefined ? member : needMember ? await bot.getMember(page.guildId, req.visitor.id) : null) : null;
    const formState = { ...(await gates(page, req.visitor, who)), ...overrides };
    return html(res, status, renderPage({
      page, guild, visitor: req.visitor ? { name: req.visitor.name } : null,
      csrf: (blockId) => (req.visitor ? auth.csrfToken(req.visitor.sessionId, page.id, blockId) : ''), formState,
    }));
  }

  router.get('/:gid/:slug', async (req, res, next) => {
    try {
      const page = lookup(req);
      if (!page) return notFound(res);
      return await sendPage(req, res, page);
    } catch (err) { return next(err); }
  });

  router.post('/:gid/:slug/f/:blockId', parseForm, auth.requireOrigin, async (req, res, next) => {
    try {
      const page = lookup(req);
      const block = page && findForm(page, req.params.blockId);
      if (!page || !block) return notFound(res);
      const guild = bot.guildSummary(page.guildId);
      const notice = (status, title, message) => html(res, status, renderNotice({ page, guild, title, message, href: pathOf(page), hrefLabel: 'Back to the page' }));

      if (!req.visitor) return notice(401, 'Please log in', 'Log in with Discord on the page, then send the form again.');
      if (!submitsByVisitor.take(req.visitor.id) || !submitsByIp.take(req.ip)) return notice(429, 'Slow down', 'You are sending forms too fast. Wait a minute and try again.');
      if (!auth.csrfValid(req.body?._csrf, req.visitor.sessionId, page.id, block.id)) return notice(403, 'This form has expired', 'Reload the page and try again.');

      const d = block.data;
      const member = await bot.getMember(page.guildId, req.visitor.id); // the only await: everything below runs without interruption
      if (d.requireMember && !member) return await sendPage(req, res, page, { status: 403, overrides: { [block.id]: { blocked: 'member' } }, member });
      const blocked = dbGate(page, block, req.visitor.id);
      if (blocked) return await sendPage(req, res, page, { status: 409, overrides: { [block.id]: blocked }, member });

      const result = validateSubmission(d, req.body);
      if (!result.ok) {
        return await sendPage(req, res, page, { status: 422, member, overrides: { [block.id]: { errors: result.errors, values: result.values, formError: 'Please fix the highlighted answers.' } } });
      }

      // Save (or, when answers must not be kept, only a receipt so "one per person" / cooldown still work) and start flows.
      const row = { guildId: page.guildId, pageId: page.id, blockId: block.id, userId: req.visitor.id };
      let responseId = uid(10);
      if (d.saveResponses !== false) responseId = db.addResponse({ ...row, userName: req.visitor.name, answers: result.answers });
      else if (d.oneResponsePerUser || cooldownMs(d)) responseId = db.addResponse({ ...row, userName: '', answers: {} });
      logger.log(page.guildId, 'info', `Form “${d.title}” was submitted by ${req.visitor.name}.`);
      runtime.fireForm({
        guildId: page.guildId, user: member?.user ?? visitorUser(req.visitor), member, page, formBlock: block, answers: result.answers,
        summary: summarize(d, result.answers), responseId, pageUrl: `${config.baseUrl}${pathOf(page)}`,
      }).catch((err) => logger.log(page.guildId, 'error', `Form flow failed: ${friendlyError(err)}`));

      // Same-origin hop first: the CSP's form-action must not see a cross-site redirect straight after a POST.
      return res.redirect(303, `${pathOf(page)}/thanks?f=${encodeURIComponent(block.id)}`);
    } catch (err) { return next(err); }
  });

  router.get('/:gid/:slug/thanks', (req, res) => {
    const page = lookup(req);
    const block = page && findForm(page, String(req.query.f ?? ''));
    if (!page || !block) return notFound(res);
    const d = block.data;
    const guild = bot.guildSummary(page.guildId);
    const target = d.onSuccess === 'redirect' ? safeUrl(d.redirectUrl) : null;
    if (target) {
      return html(res, 200, renderNotice({ page, guild, title: d.title, message: 'Thanks! Taking you to the next page…', href: target, hrefLabel: 'Continue', refreshTo: target }));
    }
    return html(res, 200, renderNotice({ page, guild, title: d.title, message: d.successMessage || 'Thanks! Your response was sent.', href: pathOf(page), hrefLabel: 'Back to the page' }));
  });

  return { router };
}
