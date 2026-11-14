import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { questionFile } from './bank';
import { notesSection } from './interviewer';
import { listSessions, loadSession, saveReview, saveSession } from './sessions';
import type { Session } from './types';
import { HttpError, loadConfig, paths, profileTexts, readPrepPack, scrub, writeText } from './workspace';

/**
 * Claude grades a finished call: every answer on technical depth, structure and delivery, with a stronger
 * way to say it. In the same call it updates the two notes files that make the next session better:
 * coach-notes.md (the candidate's recurring gaps) and interviewer-notes.md (rules from the interviewer's
 * own mistakes). Both are read into the next live prompt (interviewer.ts notesSection).
 *
 * Needs ANTHROPIC_API_KEY. Without it, GET /api/sessions/:id/review-prompt gives the same prompt to paste
 * into any Claude chat, and POST /api/sessions/:id/review saves the JSON you get back.
 */

export const reviewModel = () => process.env.REVIEW_MODEL || 'claude-opus-5-5';
export const gradingConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const AnswerSchema = z.object({
  question_id: z.string(),
  question: z.string(),
  score: z.number().int(),
  technical: z.string(),
  structure: z.string(),
  delivery: z.string(),
  rewrite: z.string(),
  fix: z.string(),
});

export const ReviewOutput = z.object({
  overall: z.number().int(),
  summary: z.string(),
  answers: z.array(AnswerSchema),
  delivery: z.string(),
  next_focus: z.array(z.string()),
  coach_notes: z.object({
    recurring_gaps: z.array(z.string()),
    getting_better: z.array(z.string()),
    drill_next: z.array(z.string()),
  }),
  interviewer_rules: z.array(z.string()),
  interviewer_bugs: z.array(z.string()),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

const RUBRIC = `You are a senior interview coach. A candidate just finished a mock interview with a live AI voice interviewer. Score it and help them do better next time.

## Score each main question (with its follow ups) from 1 to 10
- 1 to 3: wrong, missing the core idea, or not answered
- 4 to 5: textbook but shallow: right words, no trade-offs, no example
- 6 to 7: solid: correct, a trade-off or two, some real experience
- 8: senior: answer first, clear trade-offs, a specific production example with a number
- 9 to 10: would impress a demanding startup CTO: crisp, owns decisions, handles every follow up

Judge three things for every answer:
1. Content (the "technical" field): compare with the question file (its short answer first, the rest for what senior looks like). Name what was wrong or missing, concretely. For technical questions that is accuracy and depth; for behavioral, screening and soft skill questions, judge the story instead: situation, task, action, result; what the candidate personally did; a result with a number; no complaints about past employers.
2. Structure: did the first sentence answer the question? Two or three clear points? Did it end cleanly, or trail off?
3. Delivery: from the transcript and the measured metrics: long rambling sentences, fillers, hedging ("I think maybe"), "sir/madam", apologies, answers past 3 minutes.

The transcript is machine speech to text. Misheard words are the tool's fault: never mark the candidate down for a garbled word when the meaning is clear, and never invent things they did not say.
The live interviewer's silent ratings are a second opinion only. Your score is the one that counts.
If a delivery metric looks impossible (for example over 260 words per minute), say it is off and judge pace from the timestamps instead.
A question that was asked but not answered (the call ended) still gets an entry: score 1, "Not answered", and the rewrite.

## The rewrite ("a stronger way to say it")
What the candidate should say next time, as spoken words they can learn by heart:
- Headline first, then 2 or 3 points, then one line from their real experience.
- Short sentences, 6 to 12 words. Simple words. No bullet symbols, no markdown inside the text.
- Use only facts from the profile, the question file and the prep pack. Never invent a metric, a company or a project. If an example would help but none exists, write "(add your own example: ...)".
- About 60 to 90 seconds spoken (120 to 200 words); system design up to 300.

## Output fields
- answers: every main question that was asked (marked asked), in order, with its exact question_id. Skip questions never asked. Follow ups belong to their main question.
- overall: your judgement of the round, not just the average.
- summary: two or three plain sentences: how it went and the one biggest gap.
- delivery: one or two lines on delivery across the whole call.
- next_focus: up to 3 short items for the next session.

## Improve the next session
coach_notes is the full new content of the candidate's coach notes (start from the current notes below and update them with this review and the recent history):
- recurring_gaps: patterns seen in 2+ answers or sessions, with how often, e.g. "Answers end after 20 seconds with no example (4 of 5 answers, 2 sessions)".
- getting_better: a gap that improved, with the evidence. Move a gap here once two sessions in a row no longer show it; drop it after that.
- drill_next: up to 3 concrete drills.
One line per point, plain words, facts from the reviews only, at most 10 per list, merge duplicates.

interviewer_rules is the full new list of rules for the live interviewer (start from the current rules below). Check the interviewer against its rules using the transcript and the tool calls: two questions in one turn, a follow up not based on what the candidate said, repeating a question after "mhm", teaching or giving the answer away, saying a rating aloud, a follow up in a scripted screen, skipping record_note, ending early or never calling end_interview. Add a rule only for a mistake you actually saw, worded so it would have prevented it. Sharpen an existing rule instead of repeating it. At most 10 rules. Rules are about how to interview only.

interviewer_bugs: mistakes a prompt rule cannot fix (a broken tool result, audio cut off, a page problem), one line each, or an empty list.`;

/** The rubric plus the candidate's own extra rules (config.json reviewNotes). */
export function systemPrompt(): string {
  const notes = loadConfig().reviewNotes;
  return notes.length ? `${RUBRIC}\n\n## Extra rules from the candidate\n${notes.map((n) => `- ${n}`).join('\n')}` : RUBRIC;
}

const mmss = (seconds: number) => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;

/** Everything Claude needs about one session, as one user message. */
export function reviewInput(s: Session): string {
  const config = loadConfig();
  const round = config.rounds.find((r) => r.id === s.round);
  const learn = s.mode === 'learn';
  const out: string[] = [
    `# Session ${s.id}`,
    learn
      ? '- Mode: LEARN. A tutor taught each answer first (the model answer was on the candidate\'s screen) and took their doubts, then called start_recall and the candidate explained the answer back from memory. Score only the explain-back after start_recall for each question; the teaching and the doubts are context. Score a question with no explain-back as 1, "Not explained back". In delivery and the coach notes, judge the explain-back the same way. Treat interviewer_rules as rules for the tutor.'
      : '- Mode: interview (a realistic call, no help).',
    ...(round?.reviewFocus ? [`- Focus for this round: ${round.reviewFocus}`] : []),
    `- Round: ${round?.label ?? s.round} (${round?.about ?? ''}), interviewer persona: ${config.personas[s.persona]?.label ?? s.persona}, voice model ${s.model ?? '?'}`,
    `- Length ${mmss(s.durationSeconds ?? 0)}, ended: ${s.endReason ?? ''}`,
    `- Candidate: ${config.candidate.name ? `${config.candidate.name}, ` : ''}${config.candidate.summary}`,
    '',
    '## Planned questions and their question files',
  ];
  for (const p of s.plan) {
    const tag = p.added ? 'asked, added live from an answer' : p.asked ? (learn ? (p.recalled ? 'taught, then explained back' : 'taught, never explained back') : 'asked') : 'not asked';
    out.push('', `### \`${p.id}\` (${tag}): ${p.question}`);
    if (!p.asked) continue;
    const file = questionFile(p.id);
    out.push(file ? scrub(fs.readFileSync(file, 'utf8'), config).slice(0, 8000) : '(no question file on disk)');
  }
  if (s.notes.length) {
    out.push('', "## The live interviewer's silent ratings (a second opinion)");
    out.push(...s.notes.map((n) => `- \`${n.question_id}\`: ${n.rating}/10, ${n.note}`));
  }
  const m = s.metrics;
  if (m) {
    const fillers = Object.entries(m.fillers).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    out.push(
      '',
      '## Delivery metrics (measured from the transcript; speech to text drops some fillers, so treat as rough)',
      `- ${m.wordsPerMinute ?? 'n/a'} words per minute over ${m.candidateSeconds}s of answers, ${m.fillersPerMinute ?? 'n/a'} fillers per minute (${fillers}), ${m.avgWordsPerSentence ?? 'n/a'} words per sentence, longest answer ${m.longestAnswerSeconds}s, sir/madam ${m.sirMadam}, apologies ${m.apologies}`,
    );
  }
  out.push('', `## Tool calls the ${learn ? 'tutor' : 'interviewer'} made, in order (times match the transcript)`);
  for (const c of s.toolCalls) out.push(`- ${c.t !== undefined ? `[${mmss(c.t)}]` : c.at.slice(11, 19)} ${c.name}(${JSON.stringify(c.args)})${c.error ? ` ERROR ${c.error}` : ''}`);
  out.push('', '## Transcript (machine speech to text: expect misheard words)');
  for (const t of s.transcript) out.push(`[${mmss(t.start)}] ${t.who === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text.trim()}`);

  out.push('', '## Candidate profile (the only source of facts for rewrites)');
  const profile = profileTexts();
  out.push(...(profile.length ? profile.map((p) => `### ${p.file}\n${p.text.slice(0, 12000)}`) : ['(no profile files)']));
  if (s.prepPack) {
    out.push('', `## Prep pack: ${s.prepPack}`);
    try {
      out.push(readPrepPack(s.prepPack).slice(0, 12000));
    } catch {
      out.push('(the prep pack is gone)');
    }
  }

  out.push('', '## Current coach notes');
  const coach = ['recurring gaps', 'getting better', 'drill next'].map((h) => `${h}:\n${notesSection('coach', [h]).join('\n') || '(none)'}`);
  out.push(...coach);
  out.push('', '## Current interviewer rules', notesSection('interviewer', ['rules']).join('\n') || '(none)');

  const history = listSessions().filter((x) => x.id !== s.id && x.overall !== undefined).slice(0, 5);
  if (history.length) {
    out.push('', '## Recent reviewed sessions (newest first)');
    for (const h of history) {
      const r = loadSession(h.id).review;
      if (r) out.push(`- ${h.id}: ${r.overall}/10. ${r.summary ?? ""} Focus: ${(r.next_focus ?? []).join("; ")}`);
    }
  }
  return out.join('\n');
}

/** The full prompt as plain text, for grading by hand in any Claude chat. */
export function reviewPrompt(id: string): string {
  const s = loadSession(id);
  if (s.status === 'live') throw new HttpError(409, 'The session is still live');
  return `${systemPrompt()}\n\nReply with only a JSON object with these fields: overall, summary, answers (question_id, question, score, technical, structure, delivery, rewrite, fix), delivery, next_focus, coach_notes (recurring_gaps, getting_better, drill_next), interviewer_rules, interviewer_bugs.\n\n${reviewInput(s)}`;
}

/** Writes the two notes files from the lists Claude returned (each capped at 10 lines). */
export function writeNotes(out: Pick<ReviewOutput, 'coach_notes' | 'interviewer_rules'>, sessionId: string, now = new Date()): void {
  const list = (items: string[]) => (items.length ? items.slice(0, 10).map((x) => `- ${x.replace(/\s+/g, ' ').trim().slice(0, 200)}`) : ['- (none yet)']).join('\n');
  const date = now.toISOString().slice(0, 10);
  writeText(
    paths.coachNotes(),
    `# Coach notes\n\nUpdated ${date} after ${sessionId}. Read into every new interview (the gaps are probed) and every spoken debrief. You can edit this file.\n\n## Recurring gaps\n${list(out.coach_notes.recurring_gaps)}\n\n## Getting better\n${list(out.coach_notes.getting_better)}\n\n## Drill next\n${list(out.coach_notes.drill_next)}\n`,
  );
  writeText(
    paths.interviewerNotes(),
    `# Interviewer notes\n\nUpdated ${date} after ${sessionId}. Rules learned from the interviewer's own past mistakes, read into every new interview. You can edit this file.\n\n## Rules\n${list(out.interviewer_rules)}\n`,
  );
}

/** "(none yet)" placeholders are not notes. */
const real = (items: string[]) => items.filter((x) => x.trim() && !/^\(none/i.test(x.trim()));

/** Grades one ended session with Claude and saves the review. Safe to call again after a failure. */
export async function gradeSession(id: string, client: Pick<Anthropic, 'beta'> = new Anthropic()): Promise<{ overall: number; report: string; bugs: string[] }> {
  const s = loadSession(id);
  if (s.status === 'live') throw new HttpError(409, 'The session is still live');
  if (s.review) throw new HttpError(409, 'Already reviewed');
  if (!s.transcript.some((t) => t.who === 'candidate')) throw new HttpError(400, 'No answers in the transcript, nothing to grade');
  s.grading = { startedAt: new Date().toISOString() };
  delete s.reviewError;
  saveSession(s);
  try {
    const response = await client.beta.messages.parse({
      model: reviewModel(),
      max_tokens: 16000,
      // A safety classifier can decline a request; "default" retries it on a fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(ReviewOutput) },
      system: systemPrompt(),
      messages: [{ role: 'user', content: reviewInput(s) }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to grade this session');
    if (response.stop_reason === 'max_tokens') throw new Error('The review was cut off (max_tokens). Try again, or grade by hand with the review prompt.');
    const out = response.parsed_output;
    if (!out) throw new Error('Claude returned no review');
    const { report } = saveReview(id, out, new Date(), response.model);
    writeNotes(
      { coach_notes: { recurring_gaps: real(out.coach_notes.recurring_gaps), getting_better: real(out.coach_notes.getting_better), drill_next: real(out.coach_notes.drill_next) }, interviewer_rules: real(out.interviewer_rules) },
      id,
    );
    return { overall: out.overall, report, bugs: out.interviewer_bugs };
  } catch (err) {
    const fresh = loadSession(id);
    delete fresh.grading;
    fresh.reviewError = err instanceof Anthropic.APIError ? `Claude API error ${err.status ?? ''}: ${err.message}` : (err as Error).message;
    saveSession(fresh);
    throw err;
  }
}
