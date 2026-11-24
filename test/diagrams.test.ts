import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Saved diagrams: the `## Diagram` section in a bank file, Claude drafts with a fake client, saving, and a
// lesson showing the saved diagram.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-eval-diagrams-'));
Object.assign(process.env, { WORKSPACE: root, GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const LB = '# Load balancers\n\n**Priority:** 1 (must know)\n\n## Short Answer\nSpreads requests over servers.\n\n## Going Deeper\nHealth checks. Moonlight runs one.\n';
write('questions/system-design/010-load-balancers.md', LB);
write('questions/system-design/020-cap.md', '# CAP theorem\n\nPick CP or AP.\n');
write('config.json', JSON.stringify({ privateWords: ['Moonlight'] }));

const t = await import('../src/diagram-text');
const d = await import('../src/diagrams');
const m = await import('../src/sessions');
const bank = await import('../src/bank');

const FLOW = 'flowchart LR\n  A["Client"] --> B["Load balancer"] --> C["App server"]';

test('diagram section: added after the short answer, read back, replaced, marked not needed, removed', () => {
  assert.equal(t.readDiagram(LB), null);
  const one = t.setDiagram(LB, { diagram: { title: 'Request path', mermaid: FLOW } });
  assert.match(one, /Spreads requests over servers\.\n\n## Diagram\n\n\*\*Request path\*\*\n\n```mermaid\nflowchart LR[\s\S]*?```\n\n## Going Deeper/);
  assert.deepEqual(t.readDiagram(one), { diagram: { title: 'Request path', mermaid: FLOW } });
  assert.ok(!t.withoutDiagram(one).includes('mermaid'), 'notes without the diagram');
  assert.match(t.withoutDiagram(one), /## Going Deeper/, 'the rest stays');

  const two = t.setDiagram(one, { diagram: { title: 'New', mermaid: 'sequenceDiagram\n  Client->>Server: Send request' } });
  assert.equal(two.match(/## Diagram/g)?.length, 1, 'replaced, not added twice');
  assert.equal((t.readDiagram(two) as any).diagram.title, 'New');

  const none = t.setDiagram(two, { none: 'A behavioural answer.' });
  assert.deepEqual(t.readDiagram(none), { none: 'A behavioural answer.' });
  assert.equal(t.setDiagram(none, null), LB, 'removing gives back the original file');

  const noShort = '# CAP\n\nPick CP or AP.\n';
  assert.match(t.setDiagram(noShort, { diagram: { title: '', mermaid: FLOW } }), /Pick CP or AP\.\n\n## Diagram\n\n```mermaid/, 'at the end of a file without a short answer');
});

test('checkDiagram: only drawable types, no fences, directives or click links, not too big', () => {
  assert.deepEqual(t.checkDiagram(' **Path**\n', `\n${FLOW}\n`), { title: 'Path', mermaid: FLOW });
  assert.throws(() => t.checkDiagram('x', ''), /empty/);
  assert.throws(() => t.checkDiagram('x', 'pie\n "a": 1'), /flowchart LR/);
  assert.throws(() => t.checkDiagram('x', `${FLOW}\n\`\`\``), /code fence/);
  assert.throws(() => t.checkDiagram('x', `%%{init: {"securityLevel": "loose"}}%%\n${FLOW}`), /init/);
  assert.throws(() => t.checkDiagram('x', `${FLOW}\n  click A "https://x.test"`), /click/);
  assert.throws(() => t.checkDiagram('x', `flowchart LR\n${'  A --> B\n'.repeat(400)}`), /too big/);
});

const fake = (out: unknown, stop = 'end_turn', seen: any[] = []) =>
  ({ beta: { messages: { parse: async (p: unknown) => (seen.push(p), { stop_reason: stop, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, parsed_output: out }) } } }) as any;

test('drafts: Claude gets the note without private lines, the current diagram and the change; nothing is saved', async () => {
  const id = 'system-design/010-load-balancers';
  const seen: any[] = [];
  const draft = await d.draftDiagram(id, { instruction: 'add a cache box', current: { title: 'Path', mermaid: FLOW } }, fake({ needed: true, reason: '', title: ' Path with cache ', mermaid: FLOW }, 'end_turn', seen));
  assert.deepEqual(draft, { needed: true, reason: '', title: 'Path with cache', mermaid: FLOW });
  const req = seen[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.effort, 'medium');
  assert.match(req.system, /At most 8 boxes/);
  const input = req.messages[0].content as string;
  assert.match(input, /Spreads requests over servers/);
  assert.ok(!input.includes('Moonlight'), 'private words never reach Claude');
  assert.match(input, /## The current diagram[\s\S]*Load balancer/);
  assert.match(input, /## Change requested\nadd a cache box/);
  assert.match(input, /needed must be true/);
  assert.equal(t.readDiagram(fs.readFileSync(path.join(root, 'questions', `${id}.md`), 'utf8')), null, 'a draft is not saved');

  assert.ok(!d.draftInput(id, {}).includes('needed must be true'), 'a plain Add lets Claude say a picture would not help');
  assert.match(d.draftInput(id, { current: { mermaid: FLOW }, error: 'Parse error on line 2' }), /could not draw[\s\S]*Parse error on line 2/);

  assert.deepEqual(await d.draftDiagram(id, {}, fake({ needed: false, reason: 'Just a definition.', title: 'x', mermaid: 'x' })), { needed: false, reason: 'Just a definition.', title: '', mermaid: '' });
  await assert.rejects(d.draftDiagram(id, {}, fake({ needed: true, reason: '', title: 'x', mermaid: 'pie\n "a": 1' })), /can't use/);
  await assert.rejects(d.draftDiagram(id, {}, fake(null, 'refusal')), /declined/);
  await assert.rejects(d.draftDiagram('system-design/nope', {}, fake({})), /No such question/);
});

test('save: writes the file, the bank flags it, notes leave it out, and a lesson shows it with the question', async () => {
  const id = 'system-design/010-load-balancers';
  assert.throws(() => d.saveDiagram(id, { title: 'x', mermaid: 'pie' }), /flowchart LR/);
  d.saveDiagram(id, { title: 'Request path', mermaid: FLOW });
  assert.deepEqual(d.diagramFor(id).state, { diagram: { title: 'Request path', mermaid: FLOW } });
  d.saveDiagram('system-design/020-cap', { none: 'Just a trade off.' });

  const flags = Object.fromEntries(m.questionList().map((q) => [q.id, q.diagram]));
  assert.deepEqual(flags, { [id]: 'saved', 'system-design/020-cap': 'none' });
  assert.equal(bank.bankEntry(id)?.short, 'Spreads requests over servers.', 'the short answer is untouched');
  assert.ok(!m.questionNotes(id).notes.includes('mermaid'), 'the notes leave the diagram out');
  assert.match(m.questionNotes(id).notes, /Going Deeper/);

  const okFetch = (async () => new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 })) as unknown as typeof fetch;
  Object.assign(process.env, { GEMINI_API_KEY: 'test-key' });
  const { session } = await m.startSession({ questions: [id, 'system-design/020-cap'], mode: 'learn' }, { now: new Date('2026-11-20T10:00:00Z'), fetchImpl: okFetch });
  const first = m.runTool(session.id, 'next_question', {}).result as any;
  assert.deepEqual({ title: first.diagram.title, mermaid: first.diagram.mermaid }, { title: 'Request path', mermaid: FLOW });
  assert.match(first.diagram.note, /saying each label exactly as written/);
  assert.ok(!first.notes.includes('mermaid'));
  const second = m.runTool(session.id, 'next_question', {}).result as any;
  assert.equal(second.diagram, undefined, '"not needed" sends no diagram');

  d.saveDiagram(id, { remove: true });
  assert.equal(fs.readFileSync(path.join(root, 'questions', `${id}.md`), 'utf8'), LB);
});
