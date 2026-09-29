import assert from 'node:assert/strict';

// ---- an allowlist-based structural HTML check: any injected tag, handler or bad URL fails ------------------------------
const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'div', 'span', 'p', 'a', 'h1', 'h2', 'h3', 'strong', 'em', 'br', 'img', 'figure', 'figcaption', 'ul', 'ol', 'li', 'hr', 'header', 'section', 'footer', 'form', 'input', 'textarea', 'select', 'option', 'label', 'button', 'fieldset', 'b']);
const ATTRS = new Set(['lang', 'charset', 'name', 'property', 'content', 'class', 'href', 'src', 'alt', 'target', 'rel', 'loading', 'referrerpolicy', 'http-equiv', 'id', 'for', 'type', 'value', 'checked', 'selected', 'required', 'placeholder', 'maxlength', 'minlength', 'min', 'max', 'step', 'rows', 'method', 'action', 'autocomplete', 'disabled', 'role', 'aria-hidden', 'aria-labelledby']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:=(?:"[^"]*"|[^\s"'<>=`]+))?)*)\s*\/?>/y;
const ATTR = /([^\s"'<>/=]+)(?:=(?:"([^"]*)"|([^\s"'<>=`]+)))?/g;

export function assertInert(html) {
  const body = html.replace(/<style>[\s\S]*?<\/style>/, '<style></style>').replace(/^<!doctype html>/i, '');
  for (let i = body.indexOf('<'); i !== -1; i = body.indexOf('<', i + 1)) {
    TAG.lastIndex = i;
    const m = TAG.exec(body);
    assert.ok(m, `stray "<" (not a well-formed tag) near: ${body.slice(i, i + 60)}`);
    assert.ok(TAGS.has(m[2].toLowerCase()), `tag <${m[2]}> is not allowed`);
    for (const a of m[3].matchAll(ATTR)) {
      const name = a[1].toLowerCase();
      assert.ok(ATTRS.has(name), `attribute "${name}" is not allowed on <${m[2]}>`);
      const value = (a[2] ?? a[3] ?? '');
      if (['href', 'src', 'action'].includes(name)) assert.match(value.replace(/&amp;/g, '&'), /^(https?:\/\/|\/)/, `${name}="${value}" is not an http(s) or site-relative URL`);
      if (name === 'target') assert.match(m[3], /rel="[^"]*noopener/, 'target=_blank without noopener');
    }
  }
  assert.ok(!/<script/i.test(body));
}

