# voice-agent-eval

A real-time multimodal voice agent with live tool execution and an automated LLM evaluation grading engine.

You talk to the agent out loud. It runs a structured spoken session on [Gemini Live](https://ai.google.dev/gemini-api/docs/live), calls tools on your server while it talks, and follows up on what the person actually said. When the call ends, Claude grades the transcript against your own reference answers and writes a report.

- **Real-time voice, both ways.** Audio streams straight between the browser and Gemini Live. The agent hears pauses, gets interrupted, and digs into answers with follow ups.
- **Live tool execution.** The agent calls server tools mid-conversation (next question, reference answer, background lookup, notes). Every call shows on screen with its arguments and result.
- **LLM grading engine.** Claude scores each answer from 1 to 10 on technical depth, structure and delivery, explains what was missing, and writes a stronger answer using only facts from the profile.
- **Your content, plain markdown.** Questions, reference answers, profiles and context packs are files in your own folder. Nothing of yours is committed.
- **Configurable personas and rounds.** A principal architect, an SRE lead, a scripted screen with no follow ups: a round is a few lines of config.
- **Learns between sessions.** Weak answers come back sooner (spaced repetition), recurring gaps get probed in the next call, and the agent keeps notes on its own mistakes.

## How it works

```
 browser (mic + speaker)                      local server (Node, port 4747)
 ┌──────────────────────┐   1. start round   ┌──────────────────────────────┐
 │  React page          │ ─────────────────▶ │ picks questions, mints a     │
 │                      │ ◀── token + setup ─ │ one-use Gemini token         │
 │                      │                    │                              │
 │  Gemini Live socket ◀┼── voice both ways ─▶ Gemini Live (Google)        │
 │                      │                    │                              │
 │  tool call from      │ 2. run the tool    │ next_question, reference_    │
 │  the agent         ──┼──────────────────▶ │ answer, candidate_background │
 │                      │                    │ job_context, record_note ... │
 │                      │ 3. end: transcript │                              │
 │                      │ ─────────────────▶ │ metrics, then Claude grades  │
 └──────────────────────┘                    │ → reports/<id>.md            │
                                             └──────────────────────────────┘
```

1. You pick a mode (evaluate or learn) and a round (for example a system design review or an incident postmortem).
2. The server picks questions from your bank: ones due for a repeat first, then new ones. It mints a one-use Gemini token that expires shortly after the round. Your API key never reaches the browser.
3. The browser streams audio to Gemini Live directly (16 kHz microphone in, 24 kHz voice out, through AudioWorklets). When the agent needs something, it calls a tool, and the page runs it on the server and shows it.
4. When the call ends, the server measures delivery (words per minute, filler words, longest answer) and Claude grades the transcript.
5. Optional: press **Listen to the review** and a coach voice walks through the grades and lets the person practise the stronger answers out loud.

## What you can run with it

The engine is the same for every use; the content and the round settings change. The example workspace has three:

| Round | Persona | What it covers |
|---|---|---|
| System design review | Principal architect | One system end to end: requirements, API, data model, scale, failure modes |
| API trade-offs | Principal architect | Protocol choice, pagination, retry safety, with the reasons behind each |
| Incident postmortem | Site reliability lead | Timeline, impact, mitigation, root cause, follow-up actions |

A fourth round, **Architecture evaluation**, mixes all three and grounds them in a system context pack. The same setup can run technical screens, onboarding checks, or teach-back training on any topic you write questions for.

## Setup

You need Node.js 20+, a [Gemini API key](https://aistudio.google.com/apikey), and optionally an [Anthropic API key](https://console.anthropic.com/) for grading.

```bash
git clone https://github.com/abhijeet-maharana/voice-agent-eval.git
cd voice-agent-eval
npm install
npm run setup      # creates workspace/ from the examples and .env from .env.example
# put GEMINI_API_KEY (and ANTHROPIC_API_KEY) in .env
npm run build
npm start          # http://localhost:4747
```

Use headphones, so the agent's voice does not leak into the microphone. Say "hint", "repeat" or "skip" at any time.

The microphone works on `localhost` without HTTPS. The server has no login and binds to `127.0.0.1`, so keep it on your own machine, or embed it behind your own login (see below).

## Your workspace

`npm run setup` copies `examples/workspace/` to `workspace/` (ignored by git). Replace the samples with your own material:

| Path | What goes in it |
|---|---|
| `config.json` | The participant's name and a one-line summary, the session language, an optional `accent` and `secondLanguage` for the voices, private words, your rounds and personas, and `paths` to move any folder |
| `questions/<topic>/*.md` | The question bank. One file per question (format below) |
| `profile/*.md` | Background on the participant that the agent may look up for follow ups |
| `context/*.md` | Context packs: the system, team or product a round is grounded in. The example sets `"paths": { "prep": "context" }`; the default folder name is `prep/` |

The app writes these for you:

| Path | What it holds |
|---|---|
| `sessions/<id>.json` | Every call: plan, tool calls, transcript, metrics, review |
| `reports/<id>.md` | The readable review of each call |
| `progress.json` | When each question comes back (score under 6: after 1, 3, then 7 days; 6 or 7: a week; 8+: three weeks) |
| `coach-notes.md` | Recurring gaps. The next session probes them; the coach voice links to them |
| `interviewer-notes.md` | Rules learned from the agent's own mistakes, read into every new call |

You can edit both notes files by hand.

### Question format

```markdown
# Design a rate limiter for a public API.

**Priority:** 1

## Short Answer
Clarify the limit first. Token bucket or sliding window. Counters in Redis with atomic
increments. Reject with 429 and Retry-After. Decide fail open or fail closed.

## Going Deeper
What a strong answer adds: algorithm trade-offs, atomic check and increment, tiers per plan.
```

- The `# Title` is what the agent asks.
- The **Short Answer** is all the live agent sees. It uses it to judge the answer and choose follow ups, and never reads it out.
- Claude reads the whole file when it grades.
- `**Priority:**` is optional: `1` must know, `2` common (the default), `3` advanced. Rounds ask never-asked questions in priority order, random inside one level. Questions due for a repeat still come first.
- Files and folders that start with `_`, and READMEs, are skipped. A round with `"only": "design-"` uses only files with `design-` in the name.

### Private words

Anything in `privateWords` (in `config.json`) is filtered out: any line of a profile or context pack that contains one of those words never reaches the live agent or the grader. Use it for internal codenames, client names, or anything that should stay out of the models' view.

### Rounds and personas

Add a `rounds` list to `config.json` (it replaces the built-in rounds) and your own `personas`. From the example:

```json
{
  "personas": {
    "sre": { "label": "Site reliability lead", "text": "A site reliability lead running a blameless postmortem. Wants a clear timeline, the impact in numbers, what was done to stop the bleeding, the real root cause, and follow-up actions with owners." }
  },
  "rounds": [
    {
      "id": "postmortem",
      "label": "Incident postmortem",
      "about": "Walk through an outage: timeline, impact, mitigation, root cause, follow-ups.",
      "mix": { "incident-postmortem": 2 },
      "minutes": 20,
      "followUps": 3,
      "persona": "sre",
      "model": "fast",
      "job": "none",
      "reviewFocus": "Judge the postmortem: a clear timeline, impact in numbers, mitigation kept apart from the fix, the real root cause, and follow-up actions with owners."
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `mix` | Question folder to how many questions it gives |
| `followUps` | Follow ups per main question. `0` makes a scripted session with no reactions |
| `persona` | A persona from `personas`, or a built-in one (`recruiter`, `manager`, `cto`, `bigtech`, `aiscreen`) |
| `model` | `fast` (the default for the example rounds) or `thinking` (extended thinking: sharper follow ups, longer pauses; it runs its tools in the background and may say a short filler while it looks something up). On 2026-11-14 extended thinking never made a tool call (it says "a system error occurred"), so check it first with `npm run smoke:live thinking`; `GEMINI_LIVE_THINKING_LEVEL` sets low (default), medium or high |
| `job` | Whether a context pack is `required`, `optional`, or not used (`none`) |
| `only` | Optional regular expression that question ids must match |
| `topicPick` | Lets you narrow the round to a single folder on the start screen |
| `instructions` | Extra lines for the agent in this round, e.g. what to dig into |
| `reviewFocus` | What the grader should weigh most in this round |

Add the matching folders under `questions/` and they show up on the start screen. `topicOrder` lists folders in the order to show them.

### During a call

| Control | What it does |
|---|---|
| **When you finish answering** (start form) | **Button** (the default) never replies until you press **Done answering** (or Space). **Auto** replies after a pause you choose (1.5, 3 or 6 seconds), so thinking pauses don't cut you off. In Button mode, **Interrupt** (or Space) cuts its voice off and gives you the turn |
| **Pause** (or P) | Your mic stops, its voice freezes mid-sentence, and the screen is covered. **Resume** carries on from the same word |
| **Mute** | Stops your mic only |
| **Delete** (past sessions, or on a review) | Forgets a session: its file, its report, and its effect on spaced repetition (rebuilt from the sessions left). The coach notes are a summary and stay; edit them by hand if needed |

### Learn mode

Pick **Learn** on the start screen (or set `"defaultMode": "learn"` in `config.json`). The agent becomes a slow-speaking tutor (voice **Sulafat** by default; change it with **Tutor voice** or `GEMINI_LIVE_TUTOR_VOICE`):

1. It reads out the question, and the reference answer from the question file appears on screen.
2. It teaches the answer in plain spoken words and takes questions; it answers from your notes and says so when they don't cover something.
3. When the person is ready, it hides the answer and asks them to explain it back.
4. It says what they got and what they missed, allows one more try, then moves on.

After the call, Claude grades only the explain-back answers and updates spaced repetition.

### Using an existing notes folder

Point the workspace at material you already keep. Paths in `config.json` are relative to the workspace folder:

```json
{
  "paths": {
    "questions": "../docs/eval-questions",
    "profile": ["../team/engineer-profile.md"],
    "prep": "../docs/systems",
    "reports": "reports"
  },
  "skip": { "folders": ["drafts"], "files": "^(00-|notes)" },
  "reviewNotes": ["Use numbers from the profile only, never from the question files."]
}
```

| Field | Meaning |
|---|---|
| `paths` | Move any part: `questions`, `profile` (a folder or a list of files), `prep`, `sessions`, `reports`, `progress`, `coachNotes`, `interviewerNotes` |
| `skip.folders` | Question folders that are not spoken questions |
| `skip.files` | A regular expression for question file names to skip |
| `topicOrder` | Question folders in the order to list them |
| `reviewNotes` | Extra rules for the grader, added to Claude's prompt |

## Grading

With `ANTHROPIC_API_KEY` set, Claude (`claude-opus-5-5` by default, change it with `REVIEW_MODEL`) grades each call within a minute or two of ending it. It scores every main question from 1 to 10 on technical depth, structure and delivery, writes the answer to give next time using only facts from the profile, and updates the two notes files. The request uses server-side fallbacks, so if a safety check declines it, the same call retries on another model.

Without a key, grade by hand:

```bash
npm run review -- <session id> --prompt > prompt.txt   # paste into any Claude chat
# save the JSON it replies with as review.json, then:
curl -X POST localhost:4747/api/sessions/<session id>/review \
  -H 'content-type: application/json' --data @review.json
```

`npm run review -- <session id>` grades an ended session again (for example after an API error).

## Embed it in another app

The whole app is one Express router, so an existing product or dashboard can serve it under its own path, login and env:

```ts
import { createInterviewApp } from 'voice-agent-eval'; // or a path to src/app.ts

app.use(
  '/eval',
  createInterviewApp({
    workspace: '/path/to/content',         // sets WORKSPACE
    guard: requireLogin,                   // runs before every write (POST/DELETE); reads stay open
    onReview: (event) => notifyMe(event),  // after each review, or when grading fails
  }),
);
```

The page uses relative URLs, so it works under any prefix and behind a reverse proxy. A guard can answer `401` with `{ "error": "...", "unlock": "/login" }` and the page shows a **Sign in** link. The browser still needs `localhost` or HTTPS for the microphone.

Standalone, set `REVIEW_WEBHOOK_URL` to get the same review event as a JSON `POST`. To load settings from a different env file, set `DOTENV_CONFIG_PATH`.

## Cost

- **Gemini Live:** billed per minute of audio by Google. Check the current Live API pricing for your model.
- **Claude grading:** one request per call; the cost depends on the call length and the model you pick.

## Development

```bash
npm run dev        # server with reload (port 4747)
npm run dev:web    # page with hot reload on http://localhost:5173, API proxied to 4747
npm run check      # typecheck + tests (no network, no API keys needed)
npm run smoke:live # one real Gemini Live round trip (needs GEMINI_API_KEY)
```

| File | What it does |
|---|---|
| `src/app.ts` | The router: HTTP API, the built page, review hooks |
| `src/server.ts` | The standalone server around it |
| `src/sessions.ts` | Start, tool calls, end, metrics, review, report, debrief, cleanup |
| `src/interviewer.ts` | Gemini Live setup: system prompt, tools, voices, one-use token |
| `src/bank.ts` | Question bank parsing, spaced repetition, picking questions |
| `src/review.ts` | Claude grading and the notes files |
| `src/workspace.ts` | Paths, `config.json`, private word filtering |
| `web/src/live.ts` | Browser audio (AudioWorklets) and the Gemini Live socket |
| `web/src/App.tsx` | The page: setup, live call, review |

The Gemini Live model names (`gemini-3.8-live` and the extended thinking variant) can be changed with `GEMINI_LIVE_MODEL` and `GEMINI_LIVE_THINKING_MODEL` when Google renames them.

## License

MIT
