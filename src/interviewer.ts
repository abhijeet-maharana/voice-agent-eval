import fs from 'node:fs';
import type { Config } from './workspace';
import { HttpError, paths } from './workspace';
import { MAX_ADDED } from './bank';
import type { LiveModelId, Round, Session, TurnTaking } from './types';

/**
 * The live voice: Gemini Live, opened straight from the browser with a short-lived token this server
 * mints (the API key never leaves the server). This file builds what the browser sends first: the model,
 * the voice, the system prompt and the tools the interviewer may call.
 */

export function liveModels(): Record<LiveModelId, { label: string; model: string }> {
  return {
    fast: { label: 'Gemini Live: quick replies, like a real call', model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live' },
    thinking: {
      label: 'Gemini Live extended thinking: sharper follow ups, longer pauses',
      model: process.env.GEMINI_LIVE_THINKING_MODEL || 'gemini-3.8-live-extended-thinking',
    },
  };
}

export function liveConfig() {
  return {
    voice: process.env.GEMINI_LIVE_VOICE || 'Kore',
    wsUrl:
      process.env.GEMINI_LIVE_WS_URL ||
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
    configured: !!process.env.GEMINI_API_KEY,
  };
}

/** Gemini Live's 30 prebuilt HD voices and their style (Google's Live API configuration docs). */
export const VOICES: Record<string, string> = {
  Achernar: 'Soft', Achird: 'Friendly', Algenib: 'Gravelly', Algieba: 'Smooth', Alnilam: 'Firm', Aoede: 'Breezy',
  Autonoe: 'Bright', Callirrhoe: 'Easy-going', Charon: 'Informative', Despina: 'Smooth', Enceladus: 'Breathy',
  Erinome: 'Clear', Fenrir: 'Excitable', Gacrux: 'Mature', Iapetus: 'Clear', Kore: 'Firm', Laomedeia: 'Upbeat',
  Leda: 'Youthful', Orus: 'Firm', Puck: 'Upbeat', Pulcherrima: 'Forward', Rasalgethi: 'Informative',
  Sadachbia: 'Lively', Sadaltager: 'Knowledgeable', Schedar: 'Even', Sulafat: 'Warm', Umbriel: 'Easy-going',
  Vindemiatrix: 'Gentle', Zephyr: 'Bright', Zubenelgenubi: 'Casual',
};

export function pickVoice(voice: unknown, fallback: string): string {
  if (voice === undefined || voice === null || voice === '') return fallback;
  if (typeof voice !== 'string' || !VOICES[voice]) throw new HttpError(400, `Unknown voice. Pick one of: ${Object.keys(VOICES).join(', ')}`);
  return voice;
}

// ---------- Tools the interviewer can call (run by sessions.ts runTool) ----------

export const TOOLS = [
  {
    name: 'next_question',
    description: 'Get the next main interview question from the plan. Call it at the start and after you finish each question and its follow ups. Returns done=true when the plan is finished.',
  },
  {
    name: 'reference_answer',
    description: 'What a strong answer to a planned question covers. Use it to judge the answer and pick a follow up. Never read it out or hint at it.',
    parameters: { type: 'OBJECT', properties: { question_id: { type: 'STRING', description: 'The question_id from next_question.' } }, required: ['question_id'] },
  },
  {
    name: 'candidate_background',
    description: "Search the candidate's resume and profile (and the job prep pack, if any) for a claim, project, company or skill, to ask a sharper follow up.",
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A few keywords, e.g. "component library" or "CI pipeline".' } }, required: ['query'] },
  },
  {
    name: 'job_context',
    description: 'The company, role, stack and likely questions for this interview (from the prep pack). Call once at the start of a real interview.',
  },
  {
    name: 'record_note',
    description: 'Silently record your rating of the answer to one main question (after its follow ups). Call once per main question. Never say the rating out loud.',
    parameters: {
      type: 'OBJECT',
      properties: {
        question_id: { type: 'STRING', description: 'The question_id from next_question.' },
        rating: { type: 'INTEGER', description: '1 to 10. 5 = textbook but shallow, 7 = solid with trade-offs, 9 = senior, specific, production examples.' },
        note: { type: 'STRING', description: 'One line: what was strong and what was missing.' },
      },
      required: ['question_id', 'rating', 'note'],
    },
  },
  {
    name: 'related_question',
    description:
      'When the candidate brings up a technology, project, decision or situation worth exploring that the plan does not cover, get a question on it from the question bank. Ask it as your next main question (it replaces one planned question). At most twice per interview.',
    parameters: { type: 'OBJECT', properties: { topic: { type: 'STRING', description: 'A few keywords from the answer, e.g. "Kafka consumer lag" or "migrating to microservices".' } }, required: ['topic'] },
  },
  {
    name: 'end_interview',
    description: 'End the interview after your closing line: when next_question returns done, time is up, or the candidate asks to stop.',
    parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING', description: 'Why it ended, e.g. "plan finished" or "candidate asked to stop".' } }, required: ['reason'] },
  },
] as const;

/**
 * Learn mode: the same tools minus related_question, plus start_recall. next_question also returns the
 * answer, which the page shows on screen while the tutor teaches it.
 */
export const LEARN_TOOLS = [
  {
    name: 'next_question',
    description: 'Get the next question of the lesson with its model answer (also shown on the candidate\'s screen). Call it at the start and after you finish each question. Returns done=true when the lesson is finished.',
  },
  {
    name: 'reference_answer',
    description: 'The full notes for a question in the lesson (the short answer and the deeper material), to answer a doubt.',
    parameters: { type: 'OBJECT', properties: { question_id: { type: 'STRING', description: 'The question_id from next_question.' } }, required: ['question_id'] },
  },
  TOOLS[2],
  TOOLS[3],
  {
    name: 'start_recall',
    description: 'Call when the candidate is ready to explain the answer back. The page hides the answer, and from now on their words for this question are scored. Then ask them to explain it as they would in an interview.',
    parameters: { type: 'OBJECT', properties: { question_id: { type: 'STRING', description: 'The question_id from next_question.' } }, required: ['question_id'] },
  },
  {
    name: 'record_note',
    description: 'Silently record how well the candidate explained the answer back (after start_recall). Call once per question, before next_question.',
    parameters: TOOLS[4].parameters,
  },
  {
    name: 'end_interview',
    description: 'End the lesson after your closing line: when next_question returns done, time is up, or the candidate asks to stop.',
    parameters: TOOLS[6].parameters,
  },
] as const;

export const DEBRIEF_TOOLS = [
  {
    name: 'end_debrief',
    description: 'End the debrief after your closing line: when the candidate says stop, or when the review is done and they have no more questions.',
  },
] as const;

// ---------- Prompts ----------

const candidateLine = (config: Config) => (config.candidate.name ? `${config.candidate.name}, ${config.candidate.summary}` : config.candidate.summary);

/**
 * Bullets ("- ...") under the given "## " headings of a notes file (written after each review). Capped
 * (10 bullets, 200 characters each), because they go into every live prompt.
 */
export function notesSection(file: 'coach' | 'interviewer', headings: string[]): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file === 'coach' ? paths.coachNotes() : paths.interviewerNotes(), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) inside = headings.includes(h[1].toLowerCase());
    else if (inside && /^\s*-\s+\S/.test(line)) out.push(`- ${line.replace(/^\s*-\s+/, '').slice(0, 200)}`);
  }
  return out.slice(0, 10);
}

export function systemInstruction(s: Session, round: Round, config: Config): string {
  const persona = config.personas[s.persona] ?? config.personas[round.persona];
  const lines = [
    'You are a live voice interviewer running a realistic mock job interview.',
    `Candidate: ${candidateLine(config)}`,
    `Your persona: ${persona.text}`,
    `Round: ${round.label}. ${round.about} About ${round.minutes} minutes, ${s.plan.length} main question${s.plan.length === 1 ? '' : 's'}.`,
    '',
    'How to run it:',
    `- Open with one short greeting and one line on the format.${round.job !== 'none' && s.prepPack ? ' Call job_context first so you know the company and role, and introduce yourself as being from that company.' : ''}`,
    '- Get every main question from next_question. Ask exactly that question, in your own natural spoken words. Never invent main questions.',
    '- Ask one question at a time, then stop talking and let the candidate answer fully. Do not interrupt unless an answer runs past about 3 minutes.',
    '- One thing per turn: either a follow up or the next main question, never both in the same turn. Call next_question only after the candidate has answered your last follow up.',
    '- If the candidate only says "mhm", "okay" or "yes" while thinking, wait a moment; do not repeat the question straight away.',
    ...(round.followUps > 0
      ? [
          '- Listen closely and build on what the candidate says, like a real interviewer. Every follow up must come from their own words: point to what they said ("You said you learn a new stack in hours. Which one did you last learn that way?").',
          `- After each answer, you may call reference_answer to judge it. Dig deeper when the answer is vague, a claim has no example, a number is missing, or a trade-off is skipped; move on once it is solid. Up to ${round.followUps} follow up${round.followUps === 1 ? '' : 's'} per main question. Use candidate_background to check claims about their own projects and ask about the real one.`,
          '- When you move to the next main question, link it to earlier answers when it fits naturally ("Earlier you mentioned async updates. Staying on remote work, ..."). If a later answer contradicts an earlier one, ask about it.',
          `- If the candidate brings up something worth exploring that the plan does not cover (a technology, a project, a hard decision), you may call related_question with that topic and ask its question as your next main question instead. At most ${MAX_ADDED} times per interview.`,
        ]
      : ['- Ask no follow ups and do not react to answers. After each answer say only "Thank you. Next question." and move on.']),
    '- After a main question and its follow ups, call record_note once. Never say ratings or feedback out loud.',
    '- Do not teach, correct the candidate, or reveal what a good answer is. If they say "hint", give one short nudge. If they say "skip", move on. If they say "repeat", repeat the question.',
    '- Speak like a real person on a call: short sentences, at most two sentences before a question, no lists, no markdown.',
    `- Keep the interview in ${config.language}, even if the candidate switches language.`,
    '- When next_question returns done, or time is nearly up, close politely in one or two sentences, then call end_interview.',
  ];
  if (round.instructions) lines.push('', `For this round: ${round.instructions}`);
  // What past reviews learned: the candidate's recurring gaps (probed by follow ups) and rules from the
  // interviewer's own past mistakes. Both files are written after each review (review.ts).
  const gaps = notesSection('coach', ['recurring gaps', 'drill next']);
  if (gaps.length && round.followUps > 0)
    lines.push('', "What the candidate's coach has seen in earlier mock interviews. Probe these with your follow ups when they come up; never mention this list:", ...gaps);
  const rules = notesSection('interviewer', ['rules']);
  if (rules.length) lines.push('', 'Rules learned from earlier mock calls (follow them):', ...rules);
  return lines.join('\n');
}

/** The tutor of learn mode: teach each answer, take doubts, then have the candidate explain it back. */
export function learnInstruction(s: Session, round: Round, config: Config): string {
  const lines = [
    'You are a patient, friendly tutor on a voice call, helping a candidate prepare for job interviews. This is a learning session, not an interview: you teach first, then they practise.',
    `Candidate: ${candidateLine(config)}`,
    `Topic: ${round.label}. ${round.about} About ${round.minutes} minutes, ${s.plan.length} question${s.plan.length === 1 ? '' : 's'}.`,
    ...(round.instructions ? [`For this topic: ${round.instructions}`] : []),
    '',
    'For each question, in this order:',
    '1. Call next_question. It gives the question and a model answer; the same answer is on the candidate\'s screen. Read the question out.',
    '2. Teach the answer in simple spoken words: the one line headline first, then the 2 or 3 key points, then a short real example of how it shows up at work. Explain why, not just what. Two or three short sentences per turn, then check in: "Does that make sense?"',
    '3. Ask if they have any doubts. Answer each doubt simply. Use reference_answer for the deeper notes and candidate_background to link the answer to their own projects. If the notes do not cover something, say so; never invent facts.',
    '4. When they say they are ready (or have no more doubts), call start_recall, then ask them to explain the answer back in their own words, as they would in a real interview. Do not help while they explain.',
    '5. Then give honest, kind feedback in two or three sentences: what they got right, and the one or two things they missed or said unclearly. Offer one more try if they missed something important.',
    '6. Call record_note with how well they explained it back, then move on with next_question.',
    '',
    'How to speak:',
    '- Like a good teacher on a call: short sentences, simple words, no lists, no markdown, never read long text word for word.',
    '- They can say "explain again", "slower", "example", "skip", "next" or "stop" at any time; follow it.',
    `- Keep the lesson in ${config.language}, even if they switch language.`,
    '- When next_question returns done, or time is nearly up, close warmly in one or two sentences, then call end_interview.',
  ];
  const gaps = notesSection('coach', ['recurring gaps', 'drill next']);
  if (gaps.length) lines.push('', 'What their coach has seen in earlier sessions. Keep these in mind when you give feedback; never read this list out:', ...gaps);
  return lines.join('\n');
}

/** Old sessions could time answers wrongly and give impossible speeds; leave those out. */
export const plausibleWpm = (wpm: number | null | undefined) => (wpm && wpm >= 60 && wpm <= 260 ? wpm : null);

/** The coach voice that talks the candidate through a finished review. */
export function debriefInstruction(s: Session, config: Config): string {
  const r = s.review!;
  const round = config.rounds.find((x) => x.id === s.round);
  const m = s.metrics;
  const wpm = plausibleWpm(m?.wordsPerMinute);
  const history = notesSection('coach', ['recurring gaps', 'getting better']);
  const lines = [
    `You are an interview coach on a voice call with ${config.candidate.name ?? 'the candidate'}. They just finished a mock interview, and a senior reviewer scored it. Your job is to talk them through that review so they do not have to read it.`,
    '',
    'How to speak:',
    `- Simple ${config.language}, short sentences, warm but honest, like a good mentor. No lists, no markdown, no reading out headings.`,
    '- Use only what is in the review below. Never invent scores, facts or examples.',
    '- They can interrupt any time. Follow what they say: "next", "repeat", "slower", "skip to the end", "why", or "stop".',
    '',
    'Flow:',
    '1. In two or three sentences: the round, the overall score, and the one biggest thing to fix.',
    '2. Then answer by answer, in order: the question in a few words, its score, the one fix. Then say "Here is a stronger way to say it" and read the stronger answer slowly and naturally.',
    '3. After each answer ask: "Want to try saying it yourself, or shall we move on?" If they try, listen, then give one or two lines of feedback against the stronger answer: what they kept, what they missed. Let them try again once if they want.',
    '4. Then delivery in one or two sentences, and the focus points for next time.',
    '5. Ask if they have questions. When they are done or say stop, close in one sentence, then call end_debrief.',
    ...(history.length ? ['', "Their history from earlier mock interviews (link today's fixes to these when it fits, in one short line):", ...history] : []),
    '',
    `REVIEW: ${round?.label ?? s.round} round, ${s.createdAt.slice(0, 10)}, ${Math.round((s.durationSeconds ?? 0) / 60)} minutes. Overall ${r.overall} out of 10.`,
    `Summary: ${r.summary}`,
    `Focus next time: ${r.next_focus.join('; ')}`,
    `Delivery: ${r.delivery}${wpm ? ` Measured pace: ${wpm} words per minute.` : ''}${m?.fillersPerMinute != null ? ` Filler words per minute: ${m.fillersPerMinute}.` : ''}`,
    '',
    ...r.answers.flatMap((a, i) => [
      `Answer ${i + 1}. Question: ${a.question}. Score ${a.score} out of 10.`,
      `Technical: ${a.technical}`,
      `Structure: ${a.structure}`,
      `Delivery: ${a.delivery}`,
      `Fix: ${a.fix}`,
      `Stronger way to say it: ${a.rewrite.replace(/\s*\n+\s*/g, ' ')}`,
      '',
    ]),
  ];
  return lines.join('\n');
}

export const DEFAULT_TURN_TAKING: TurnTaking = { mode: 'auto', pauseMs: 3000 };

/** The page's choice, checked: `auto` with a pause of 0.5 to 10 seconds, or `button`. */
export function pickTurnTaking(v: unknown): TurnTaking {
  if (v === undefined || v === null) return DEFAULT_TURN_TAKING;
  const t = v as Partial<TurnTaking>;
  if (t.mode !== 'auto' && t.mode !== 'button') throw new HttpError(400, 'turnTaking.mode must be auto or button');
  const pauseMs = t.pauseMs === undefined ? DEFAULT_TURN_TAKING.pauseMs : Number(t.pauseMs);
  if (!Number.isFinite(pauseMs) || pauseMs < 500 || pauseMs > 10_000) throw new HttpError(400, 'turnTaking.pauseMs must be 500 to 10000');
  return { mode: t.mode, pauseMs: Math.round(pauseMs) };
}

/** The same rule for every voice: thinking pauses are normal. */
function turnRule(t: TurnTaking): string {
  return t.mode === 'button'
    ? 'Turn taking: the candidate presses a Done button when they finish speaking, so each turn you receive is complete. Silence before that is just thinking. Reply to the whole turn.'
    : 'Turn taking: the candidate may pause for a few seconds to think. A pause is not the end of an answer: never fill the silence, never repeat the question because of it, never answer for them.';
}

/** Gemini's voice activity detection for the choice: off for `button`; for `auto`, a longer, less eager end of speech. */
function realtimeInputConfig(t: TurnTaking) {
  return t.mode === 'button'
    ? { automaticActivityDetection: { disabled: true }, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' }
    : { automaticActivityDetection: { disabled: false, endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: t.pauseMs } };
}

/** A Gemini Live setup (BidiGenerateContentSetup): audio out in the given voice, both sides transcribed, the given tools. */
export function liveSetup(model: string, instruction: string, tools: readonly object[], voice: string, turnTaking: TurnTaking = DEFAULT_TURN_TAKING) {
  return {
    setup: {
      model: model.startsWith('models/') ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
      systemInstruction: { parts: [{ text: `${instruction}\n\n${turnRule(turnTaking)}` }] },
      realtimeInputConfig: realtimeInputConfig(turnTaking),
      // Live models may run function calls in the background by default (NON_BLOCKING); the interview
      // waits for each result (the next question, the reference answer), so every tool is BLOCKING.
      tools: [{ functionDeclarations: tools.map((t) => ({ ...t, behavior: 'BLOCKING' })) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without compression an audio session ends after 15 minutes.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
    },
  };
}

/** A short-lived Gemini token for one browser session; the API key never leaves this server. */
export async function mintToken(minutes: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(503, 'GEMINI_API_KEY is not set in .env, so the live interviewer is off (see README, Setup)');
  // One use; resuming a dropped connection (every ~10 minutes) does not count as a use, and stays
  // allowed until the token expires.
  const expireTime = new Date(Date.now() + (minutes + 15) * 60_000).toISOString();
  const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime: expireTime }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
  if (!res.ok || !body.name) throw new HttpError(502, `Gemini token request failed (${res.status}): ${body.error?.message ?? 'no token in the answer'}`);
  return body.name;
}
