import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { questionFile } from './bank';
import { type DiagramState, type SavedDiagram, checkDiagram, readDiagram, setDiagram, withoutDiagram } from './diagram-text';
import { gradingConfigured } from './review';
import { HttpError, scrub, writeText } from './workspace';

/**
 * Saved diagrams for bank items. Claude draws one from the item's file (or revises one when asked: "add a
 * cache box"), the page previews it, and saving writes it into the file (diagram-text.ts has the format).
 * A lesson then shows the saved diagram instead of having the voice model draw one live.
 *
 * Uses the same Claude key as grading. Drafts are never saved on their own: the page saves what you keep.
 */

export const diagramModel = () => process.env.DIAGRAM_MODEL || 'claude-opus-5-5';

const DraftOutput = z.object({
  needed: z.boolean(),
  reason: z.string(),
  title: z.string(),
  mermaid: z.string(),
});
export type Draft = z.infer<typeof DraftOutput>;

export const DIAGRAM_SYSTEM = `You draw small teaching diagrams in Mermaid for one study note. The learner sees the diagram next to the note. A voice tutor may walk through it, naming each box out loud, and each box appears on screen when its label is spoken. The learner may also be tested by hiding the labels and naming each box from memory.

Rules:
- Show the moving parts of the answer: a flow, layers, a request path, parts that talk to each other, a before and after. Use what the note says. Do not add facts the note does not support.
- Use "flowchart LR" for flows and parts, "flowchart TD" for layers or a top-down flow, and "sequenceDiagram" when the order of calls between a few actors is the point.
- At most 8 boxes (or 5 actors and 10 messages in a sequence). Fewer is better. One idea per diagram.
- Labels of 1 to 4 everyday words someone would say out loud ("Load balancer", not "LB"), each label different from the others.
- Flowchart labels go in double quotes: A["Client"]. Node ids are short letters or words with no spaces.
- Arrow labels only when they add meaning, 1 to 3 words: A -->|"HTTP request"| B. Sequence messages without quotes: Client->>Server: Send request
- Plain Mermaid only: no style, classDef, click, links, HTML, emoji, init directives or comments.
- title: what the picture shows, 2 to 6 words.
- needed is false when a picture would not help: a behavioural or HR answer, a single definition with no parts, a list of tips. Then reason says why in one short sentence, and title and mermaid are empty. When needed is true, reason is empty.
- When revising, change only what the request asks and keep the rest. When given a drawing error, fix the code so it draws, keeping the same picture.`;

export interface DraftInput {
  /** What to change, in the learner's words ("add a cache box", "make it a sequence"). */
  instruction?: unknown;
  /** The diagram being revised (a saved one or an unsaved draft). */
  current?: unknown;
  /** The error the page got drawing `current`, to fix it. */
  error?: unknown;
  /** Draw even when Claude would say a picture is not needed (the learner asked for one). */
  force?: unknown;
}

function fileText(id: string): string {
  const file = questionFile(id);
  if (!file) throw new HttpError(404, 'No such question');
  return fs.readFileSync(file, 'utf8');
}

/** The saved diagram of one bank item, or its "not needed" mark, or nothing. */
export function diagramFor(id: string): { id: string; state: DiagramState; drawing: boolean } {
  return { id, state: readDiagram(scrub(fileText(id))), drawing: gradingConfigured() };
}

/** The user message: the note (private lines dropped, old diagram taken out), then what to do. */
export function draftInput(id: string, input: DraftInput): string {
  const note = withoutDiagram(scrub(fileText(id))).trim().slice(0, 12000);
  const out = ['## The study note', note];
  const current = input.current && typeof input.current === 'object' ? (input.current as Record<string, unknown>) : null;
  if (current?.mermaid) {
    out.push('', '## The current diagram', `Title: ${String(current.title ?? '').slice(0, 80)}`, '```mermaid', String(current.mermaid).slice(0, 4000), '```');
  }
  const instruction = String(input.instruction ?? '').trim().slice(0, 500);
  const error = String(input.error ?? '').trim().slice(0, 500);
  if (error) out.push('', '## The page could not draw the current diagram', error, '', 'Fix it so it draws. Keep the same picture.');
  else if (instruction) out.push('', '## Change requested', instruction, '', current?.mermaid ? 'Revise the current diagram.' : 'Draw a diagram that does this.');
  else out.push('', current?.mermaid ? 'Redraw the current diagram so it is clearer.' : 'Draw a diagram for this note.');
  if (input.force || instruction || error || current?.mermaid) out.push('The learner asked for a picture, so needed must be true.');
  return out.join('\n');
}

/** Asks Claude for a diagram (new, revised or fixed). Nothing is saved. */
export async function draftDiagram(id: string, input: DraftInput, client: Pick<Anthropic, 'beta'> = new Anthropic()): Promise<Draft> {
  const content = draftInput(id, input);
  let response;
  try {
    response = await client.beta.messages.parse({
      model: diagramModel(),
      max_tokens: 16000,
      // A safety classifier can decline a request; "default" retries it on a fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(DraftOutput) },
      system: DIAGRAM_SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new HttpError(502, 'Claude declined to draw this one.');
  if (response.stop_reason === 'max_tokens') throw new HttpError(502, 'The drawing was cut off. Try again.');
  const out = response.parsed_output;
  if (!out) throw new HttpError(502, 'Claude returned no diagram.');
  const u = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  console.log(`[voice-agent-eval] diagram ${id}: ${out.needed ? 'drawn' : 'not needed'}, ${u?.input_tokens ?? '?'} in / ${u?.output_tokens ?? '?'} out tokens`);
  if (!out.needed) return { needed: false, reason: out.reason.trim() || 'A picture would not help here.', title: '', mermaid: '' };
  try {
    const clean = checkDiagram(out.title, out.mermaid);
    return { needed: true, reason: '', ...clean };
  } catch (err) {
    throw new HttpError(502, `Claude drew something the page can't use: ${(err as Error).message} Try again.`);
  }
}

/** Saves a diagram into the item's file, marks it "not needed" (`none`), or removes the section (`remove`). */
export function saveDiagram(id: string, body: { title?: unknown; mermaid?: unknown; none?: unknown; remove?: unknown }): { id: string; state: DiagramState } {
  const file = questionFile(id);
  if (!file) throw new HttpError(404, 'No such question');
  let value: { diagram: SavedDiagram } | { none: string } | null;
  if (body.remove) value = null;
  else if (typeof body.none === 'string') value = { none: body.none.slice(0, 300) || 'Not needed for this question.' };
  else {
    try {
      value = { diagram: checkDiagram(body.title, body.mermaid) };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  writeText(file, setDiagram(fs.readFileSync(file, 'utf8'), value));
  return { id, state: value };
}
