// Maths in text: {{value | add:1 | commas}} and friends.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderTemplate } from '../server/engine/template.js';

const scope = {
  var: { five: 5, ten: '10', text: 'hello', big: 1234567.891, neg: -7.5, zero: 0, tenth: 0.1, fifth: 0.2, list: [1, 2], yes: true },
  guild: { vars: { joins: 41 }, memberCount: 1204 },
  user: { name: 'mia' },
};
const r = (t) => renderTemplate(t, scope);

describe('maths filters', () => {
  it('add, sub, mul, div, mod, min and max', () => {
    assert.equal(r('{{guild.vars.joins | add:1}}'), '42');
    assert.equal(r('{{var.five | sub:8}}'), '-3');
    assert.equal(r('{{var.five | mul:4}}'), '20');
    assert.equal(r('{{var.five | div:2}}'), '2.5');
    assert.equal(r('{{var.ten | mod:4}}'), '2', 'numbers stored as text work too');
    assert.equal(r('{{var.five | min:3}}'), '3');
    assert.equal(r('{{var.five | max:9}}'), '9');
  });

  it('abs, floor, ceil and round (with an optional number of decimals)', () => {
    assert.equal(r('{{var.neg | abs}}'), '7.5');
    assert.equal(r('{{var.neg | floor}}'), '-8');
    assert.equal(r('{{var.neg | ceil}}'), '-7');
    assert.equal(r('{{var.big | round}}'), '1234568');
    assert.equal(r('{{var.big | round:1}}'), '1234567.9');
    assert.equal(r('{{var.big | round:2}}'), '1234567.89');
    assert.equal(r('{{var.neg | round}}'), '-7', 'Math.round semantics: halves go up');
  });

  it('commas and fixed give text you can show', () => {
    assert.equal(r('{{guild.memberCount | commas}}'), '1,204');
    assert.equal(r('{{var.big | commas}}'), '1,234,567.891');
    assert.equal(r('{{var.neg | commas}}'), '-7.5');
    assert.equal(r('{{var.five | fixed:2}}'), '5.00', 'fixed keeps trailing zeros');
    assert.equal(r('{{var.five | fixed}}'), '5.00', 'two decimals by default');
    assert.equal(r('{{var.big | fixed:0}}'), '1234568');
    assert.equal(r('{{var.five | round:2}}'), '5', 'round does not');
  });

  it('chains left to right', () => {
    assert.equal(r('{{guild.vars.joins | add:1 | mul:2 | sub:4 | commas}}'), '80');
    assert.equal(r('Members: {{guild.vars.joins | default:0 | add:1 | commas}}'), 'Members: 42');
    assert.equal(r('{{var.big | mul:1000 | round | commas}}'), '1,234,567,891');
  });

  it('a missing or empty value counts as 0, like Add on a variable', () => {
    assert.equal(r('{{var.nothing | add:1}}'), '1');
    assert.equal(r('{{guild.vars.nothing | add:1 | commas}}'), '1');
    assert.equal(r('{{var.zero | add:1}}'), '1');
    assert.equal(renderTemplate('{{x | add:1}}', { x: '' }), '1');
    assert.equal(renderTemplate('{{x | add:1}}', { x: null }), '1');
    assert.equal(r('{{var.nothing | round}}'), '0');
  });

  it('takes a variable as the second value', () => {
    assert.equal(r('{{var.five | add:var.ten}}'), '15');
    assert.equal(r('{{guild.vars.joins | mul:var.five}}'), '205');
    assert.equal(r('{{var.five | add:var.nothing}}'), '5', 'a missing second value counts as 0');
    assert.equal(r('{{var.five | add: var.five }}'), '10', 'spaces do not matter');
  });

  it('leaves what it cannot calculate as it was', () => {
    assert.equal(r('{{var.text | add:1}}'), 'hello', 'not a number');
    assert.equal(r('{{var.list | add:1}}'), '1, 2', 'a list is not a number');
    assert.equal(r('{{var.yes | add:1}}'), 'true', 'nor is true');
    assert.equal(r('{{var.five | div:0}}'), '5', 'dividing by zero');
    assert.equal(r('{{var.five | mod:0}}'), '5');
    assert.equal(r('{{var.five | div:var.zero}}'), '5');
    assert.equal(r('{{var.text | commas}}'), 'hello');
    assert.equal(r('{{var.text | fixed:2}}'), 'hello');
    assert.equal(renderTemplate('{{x | mul:10}}', { x: 1e308 }), String(1e308), 'a result too big to be a number');
    assert.equal(renderTemplate('{{x | add:1}}', { x: 'Infinity' }), 'Infinity');
  });

  it('tidies floating point noise', () => {
    assert.equal(r('{{var.tenth | add:var.fifth}}'), '0.3');
    assert.equal(r('{{var.tenth | mul:3}}'), '0.3');
    assert.equal(r('{{var.five | div:3 | round:2}}'), '1.67');
    assert.equal(r('{{var.neg | mul:0}}'), '0', 'no negative zero');
  });

  it('keeps the existing filters working next to it', () => {
    assert.equal(r('{{user.name | upper}}'), 'MIA');
    assert.equal(r('{{var.nothing | default:none}}'), 'none');
    assert.equal(r('{{var.nothing | default:0 | add:5}}'), '5');
    assert.equal(r('{{user.name | length | add:1}}'), '4');
    assert.equal(r('{{var.text | nosuchfilter}}'), 'hello', 'an unknown filter still does nothing');
  });

  it('stays safe: arguments only read own properties, values are not re-evaluated', () => {
    assert.equal(r('{{var.five | add:constructor}}'), '5');
    assert.equal(r('{{var.five | add:__proto__}}'), '5');
    assert.equal(r('{{var.five | add:var.constructor.length}}'), '5');
    const nasty = { x: '{{secret}}', secret: 'leak' };
    assert.equal(renderTemplate('{{x | add:1}}', nasty), '{{secret}}', 'a value that looks like a template is left alone');
    assert.equal(renderTemplate('{{x | commas}}', nasty), '{{secret}}');
  });

  it('clamps the number of decimals', () => {
    assert.equal(r('{{var.five | fixed:99}}'), '5.0000000000');
    assert.equal(r('{{var.five | fixed:-3}}'), '5');
    assert.equal(r('{{var.five | fixed:abc}}'), '5.00');
  });
});
