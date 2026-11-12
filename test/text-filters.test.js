// Text, list and date filters in {{ … }}: replace, truncate, split / join, first / last / at, random, capitalize and date.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FILTER_NAMES, renderTemplate, toList } from '../server/engine/template.js';

const scope = {
  var: {
    text: 'hello world, hello', long: 'abcdefghij', emoji: '🎉🎉🎉🎉🎉', csv: 'pizza, sushi ,tacos', lines: 'one\ntwo\nthree', list: ['a', 'b', 'c'],
    json: '["x","y"]', iso: '2024-01-02T03:04:05.000Z', seconds: 1700000000, ms: 1700000000000, n: 5, two: 2, empty: '',
  },
  loop: { index: 3 },
  option: { reason: 'spamming the general channel with links' },
};
const r = (t) => renderTemplate(t, scope);

describe('text filters', () => {
  it('replace swaps every occurrence, exactly as written', () => {
    assert.equal(r('{{var.text | replace:hello,bye}}'), 'bye world, bye');
    assert.equal(r('{{var.text | replace:Hello,bye}}'), 'hello world, hello', 'capital letters matter');
    assert.equal(r('{{var.text | replace:world}}'), 'hello , hello', 'no second value removes it');
    assert.equal(r('{{var.text | replace}}'), 'hello world, hello', 'nothing to look for changes nothing');
    assert.equal(r('{{var.text | replace:.,!}}'), 'hello world, hello', 'a dot is a dot, not a pattern');
  });

  it('quotes keep commas and spaces in what is replaced', () => {
    assert.equal(r('{{var.text | replace:", "," · "}}'), 'hello world · hello');
    assert.equal(r("{{var.text | replace:' ','_'}}"), 'hello_world,_hello');
    assert.equal(r('{{var.csv | replace:",",";"}}'), 'pizza; sushi ;tacos');
  });

  it('truncate shortens long text and marks the cut', () => {
    assert.equal(r('{{var.long | truncate:5}}'), 'abcd…');
    assert.equal(r('{{var.long | truncate:10}}'), 'abcdefghij', 'already short enough');
    assert.equal(r('{{var.long | truncate:50}}'), 'abcdefghij');
    assert.equal(r('{{option.reason | truncate:20}}'), 'spamming the genera…');
    assert.equal(r('{{var.emoji | truncate:3}}'), '🎉🎉…', 'an emoji is never cut in half');
    assert.equal(r('{{var.long | truncate:var.n}}'), 'abcd…', 'the length can be a variable');
    assert.equal(r('{{var.long | truncate:0}}'), 'abcdefghij', 'a length that makes no sense changes nothing');
    assert.equal(r('{{var.long | truncate:abc}}'), 'abcdefghij');
    assert.equal([...r(`{{var.long | truncate}}`)].length, 10, '100 by default');
  });

  it('capitalize makes the first letter a capital', () => {
    assert.equal(r('{{var.text | capitalize}}'), 'Hello world, hello');
    assert.equal(r('{{var.empty | capitalize}}'), '');
  });
});

describe('list filters', () => {
  it('split makes a list, join puts one back together', () => {
    assert.equal(r('{{var.csv | split | length}}'), '3');
    assert.equal(r('{{var.csv | split | join:" / "}}'), 'pizza / sushi / tacos');
    assert.equal(r('{{var.text | split:" " | length}}'), '3', 'split on something else');
    assert.equal(r('{{var.list | join:-}}'), 'a-b-c');
    assert.equal(r('{{var.list | join}}'), 'a, b, c');
    assert.equal(r('{{var.list | split | length}}'), '3', 'a list stays a list');
  });

  it('first, last and at pick one item — from a list or from text', () => {
    assert.equal(r('{{var.list | first}}'), 'a');
    assert.equal(r('{{var.list | last}}'), 'c');
    assert.equal(r('{{var.list | at:2}}'), 'b', '1 is the first');
    assert.equal(r('{{var.list | at:-1}}'), 'c', 'negative counts from the end');
    assert.equal(r('{{var.list | at:loop.index}}'), 'c', 'the position can be a variable');
    assert.equal(r('{{var.list | at:9}}'), '', 'past the end is blank');
    assert.equal(r('{{var.list | at:0}}'), '');
    assert.equal(r('{{var.csv | first}}'), 'pizza', 'text is split at commas');
    assert.equal(r('{{var.lines | last}}'), 'three', 'and at line breaks');
    assert.equal(r('{{var.json | at:2}}'), 'y', 'a JSON list is read as one');
    assert.equal(r('{{var.nothing | first | default:none}}'), 'none');
  });

  it('random picks one of the items', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(r('{{var.csv | random}}'));
    assert.deepEqual([...seen].sort(), ['pizza', 'sushi', 'tacos']);
    assert.equal(r('{{var.nothing | random}}'), '', 'nothing to pick from');
    assert.equal(r('{{var.n | random}}'), '5', 'one value is the only choice');
  });

  it('toList reads lists, JSON lists and separated text the same way the Loop block does', () => {
    assert.deepEqual(toList(['a']), ['a']);
    assert.deepEqual(toList('a, b\nc'), ['a', 'b', 'c']);
    assert.deepEqual(toList('[1,2]'), [1, 2]);
    assert.deepEqual(toList('[not json'), ['[not json']);
    assert.deepEqual(toList(''), []);
    assert.deepEqual(toList(undefined), []);
    assert.deepEqual(toList(7), [7]);
  });
});

describe('the date filter', () => {
  it('turns a date into a Discord timestamp, which Discord shows in each reader’s own time zone', () => {
    assert.equal(r('{{var.iso | date}}'), '<t:1704164645:f>');
    assert.equal(r('{{var.iso | date:R}}'), '<t:1704164645:R>');
    assert.equal(r('{{var.iso | date:relative}}'), '<t:1704164645:R>');
    assert.equal(r('{{var.iso | date:D}}'), '<t:1704164645:D>');
    assert.equal(r('{{var.iso | date:t}}'), '<t:1704164645:t>');
    assert.equal(r('{{var.iso | date:nonsense}}'), '<t:1704164645:f>', 'an unknown style is the default one');
    assert.equal(r('{{var.iso | date:constructor}}'), '<t:1704164645:f>');
  });

  it('reads seconds and milliseconds too, so maths works first', () => {
    assert.equal(r('{{var.seconds | date:R}}'), '<t:1700000000:R>');
    assert.equal(r('{{var.ms | date:R}}'), '<t:1700000000:R>');
    assert.equal(r('{{var.seconds | add:3600 | date:R}}'), '<t:1700003600:R>', '“ends in an hour”');
  });

  it('gives the plain number or the ISO date when asked', () => {
    assert.equal(r('{{var.iso | date:unix}}'), '1704164645');
    assert.equal(r('{{var.seconds | date:iso}}'), '2023-11-14T22:13:20.000Z');
  });

  it('leaves what is not a date as it was', () => {
    assert.equal(r('{{var.text | date}}'), 'hello world, hello');
    assert.equal(r('{{var.empty | date}}'), '');
    assert.equal(r('{{var.nothing | date}}'), '');
    assert.equal(r('{{var.list | date}}'), 'a, b, c');
  });
});

describe('filters in general', () => {
  it('chain with the older ones', () => {
    assert.equal(r('{{var.csv | split | first | upper}}'), 'PIZZA');
    assert.equal(r('{{var.text | replace:hello,hi | truncate:8 | capitalize}}'), 'Hi worl…');
    assert.equal(r('{{var.list | length | add:1}}'), '4');
  });

  it('an unknown filter, or a name every object has, changes nothing and never fails', () => {
    for (const name of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(r(`{{var.text | ${name}}}`), 'hello world, hello', name);
    }
  });

  it('lists every filter by name', () => {
    for (const name of ['default', 'upper', 'replace', 'truncate', 'split', 'join', 'first', 'last', 'at', 'random', 'capitalize', 'date', 'add', 'commas']) {
      assert.ok(FILTER_NAMES.includes(name), name);
    }
    assert.equal(new Set(FILTER_NAMES).size, FILTER_NAMES.length);
  });

  it('text that came from a variable is never read as a template again', () => {
    assert.equal(renderTemplate('{{a | replace:x,y}}', { a: '{{b}} x', b: 'secret' }), '{{b}} y');
    assert.equal(renderTemplate('{{a | first}}', { a: ['{{b}}'], b: 'secret' }), '{{b}}');
  });
});
