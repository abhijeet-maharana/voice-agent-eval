import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../web/src/md-parse';

test('notes markdown: tables, quotes, lists and diagrams become blocks', () => {
  const blocks = parse(
    [
      '# Question?',
      '## Short Answer',
      '> "First line.',
      '>',
      '> Second para."',
      '',
      '| A | B |',
      '|---|:--|',
      '| `x` | **y** |',
      '',
      '- **Headline:** one',
      '  - nested',
      '1. first',
      '',
      '```',
      '  ┌──┐  keep   spacing',
      '```',
      'plain line one',
      'continues here',
      '---',
    ].join('\n'),
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'heading', 'quote', 'table', 'list', 'code', 'p', 'hr'],
  );
  assert.deepEqual(blocks[2], { kind: 'quote', paras: ['"First line.', 'Second para."'] });
  assert.deepEqual(blocks[3], { kind: 'table', head: ['A', 'B'], rows: [['`x`', '**y**']] });
  assert.deepEqual(
    blocks[4].kind === 'list' && blocks[4].items.map((i) => [i.depth, i.marker]),
    [[0, ''], [1, ''], [0, '1.']],
  );
  assert.equal(blocks[5].kind === 'code' && blocks[5].text, '  ┌──┐  keep   spacing');
  assert.equal(blocks[6].kind === 'p' && blocks[6].text, 'plain line one continues here');
});

test('a pipe line without a separator row is a paragraph, not a table', () => {
  assert.deepEqual(parse('| not a table').map((b) => b.kind), ['p']);
});
