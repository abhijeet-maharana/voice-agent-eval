# voice-interviewer

A live AI interviewer you talk to out loud. Gemini Live asks the questions and follows up on what you actually said. Claude scores every answer afterwards and writes a stronger way to say it. You bring the questions.

- **Real voice, real pressure.** You answer out loud, it listens and digs into your answer with follow ups, like a real interviewer.
- **Your material.** Questions, resume and company prep notes are plain markdown files in your own folder. Nothing is committed.
- **Nothing hidden.** Every tool the interviewer calls (next question, reference answer, your background) shows on screen with its arguments and result.
- **Any kind of interview.** Frontend, backend, databases, system design, soft skills, communication: a round is a few lines of config pointing at your question folders.
- **Learn mode.** A tutor shows the answer, teaches it, takes your doubts, then asks you to explain it back. Only your explanation is scored.
- **Gets better each session.** Weak answers come back sooner (spaced repetition). Your recurring gaps get probed in the next call, and the interviewer learns from its own mistakes.

## How it works

```
 browser (mic + speaker)                      local server (Node, port 4747)
 ┌──────────────────────┐   1. start round   ┌──────────────────────────────┐
 │  React page          │ ─────────────────▶ │ picks questions, mints a     │
 │                      │ ◀── token + setup ─ │ short-lived Gemini token     │
 │                      │                    │                              │
 │  Gemini Live socket ◀┼── voice both ways ─▶ Gemini Live (Google)        │
 │                      │                    │                              │
 │  tool call from      │ 2. run the tool    │ next_question, reference_    │
 │  the interviewer   ──┼──────────────────▶ │ answer, candidate_background │
 │                      │                    │ job_context, record_note ... │
 │                      │ 3. end: transcript │                              │
 │                      │ ─────────────────▶ │ metrics, then Claude grades  │
 └──────────────────────┘                    │ → reports/<id>.md            │
                                             └──────────────────────────────┘
```

1. You pick a mode (interview or learn) and a round (recruiter screen, behavioral, tech deep dive, system design, communication, real company interview, AI video screen, or your own).
2. The server picks questions from your bank: ones due for repeat first, then new ones. It mints a one-use Gemini token. Your API key never reaches the browser.
3. The browser talks to Gemini Live directly. When the interviewer needs something (the next question, what a strong answer covers, a line from your resume), it calls a tool, and the page runs it on the server and shows it.
4. When the call ends, the server measures delivery (words per minute, fillers, longest answer) and Claude grades the transcript.
5. Optional: press **Listen to the review** and a coach voice walks you through it, and lets you practise the stronger answers out loud.

## Setup

You need Node.js 20+, a [Gemini API key](https://aistudio.google.com/apikey), and optionally an [Anthropic API key](https://console.anthropic.com/) for grading.

```bash
git clone https://github.com/abhijeet-maharana/voice-interviewer.git
cd voice-interviewer
npm install
npm run setup      # creates workspace/ from the examples and .env from .env.example
# put GEMINI_API_KEY (and ANTHROPIC_API_KEY) in .env
npm run build
npm start          # http://localhost:4747
```

Use headphones, so the interviewer's voice does not leak into your microphone. Say "hint", "repeat" or "skip" at any time.

The microphone works on `localhost` without HTTPS. The server has no login and binds to `127.0.0.1`, so keep it on your own machine.

## Your workspace

`npm run setup` copies `examples/workspace/` to `workspace/` (ignored by git). Replace the samples with your own material:

| Path | What goes in it |
|---|---|
| `config.json` | Your name and a one-line summary, the interview language, private words, and optionally your own rounds and personas |
| `questions/<topic>/*.md` | The question bank. One file per question (format below) |
| `profile/*.md` | Your resume and anything about you the interviewer may look up for follow ups |
| `prep/*.md` | One file per real interview: company, role, stack, likely questions. The "Real interview" round needs one |

The app writes these for you:

| Path | What it holds |
|---|---|
| `sessions/<id>.json` | Every call: plan, tool calls, transcript, metrics, review |
| `reports/<id>.md` | The readable review of each call |
| `progress.json` | When each question comes back (under 6: after 1, 3, then 7 days; 6 or 7: a week; 8+: three weeks) |
| `coach-notes.md` | Your recurring gaps. The next interviewer probes them; the coach voice links to them |
| `interviewer-notes.md` | Rules learned from the interviewer's own mistakes, read into every new call |

You can edit both notes files by hand.

### Question format

```markdown
# Explain the Node.js event loop.

## Short Answer
One thread runs JavaScript. The loop goes through phases: timers, poll, check.
Microtasks run between callbacks. Blocking the thread blocks every request.

## Going Deeper
What a senior answer adds: a production example, how you found it, how you fixed it.
```

- The `# Title` is what the interviewer asks.
- The **Short Answer** is all the live interviewer sees. It uses it to judge your answer and choose follow ups, and never reads it out.
- Claude reads the whole file when it grades.
- Files and folders that start with `_`, and READMEs, are skipped. A file named `...tell-me-about-yourself...` opens a round, `...questions-to-ask...` closes it, and the system design round only uses files with `design-` in the name.

### Private words

Anything in `privateWords` (in `config.json`) is filtered out: any line of your profile or prep packs that contains one of those words never reaches the interviewer or the reviewer. Use it for a side project, a client name, or anything you don't want an interviewer to bring up.

### Your own rounds

The default rounds use the example folders (`screening`, `behavioral`, `nodejs`, `typescript`, `react`, `system-design`, `ai`). To use your own folders, add a `rounds` list to `config.json`. It replaces the defaults:

```json
{
  "rounds": [
    {
      "id": "python",
      "label": "Python deep dive",
      "about": "Core Python and Django with follow ups.",
      "mix": { "python": 3, "django": 2 },
      "minutes": 25,
      "followUps": 2,
      "persona": "cto",
      "model": "fast",
      "job": "optional",
      "topicPick": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `mix` | Question folder to how many questions it gives |
| `followUps` | Follow ups per main question. `0` makes a scripted screen with no reactions |
| `persona` | `recruiter`, `manager`, `cto`, `bigtech`, `aiscreen`, or your own under `personas` |
| `model` | `fast` (replies in about a second) or `thinking` (sharper follow ups, longer pauses) |
| `job` | Whether a prep pack is `required`, `optional`, or not used (`none`) |
| `only` | Optional regular expression that question ids must match |
| `topicPick` | Lets you narrow the round to a single folder on the start screen |
| `instructions` | Extra lines for the interviewer in this round, e.g. what to dig into |
| `reviewFocus` | What the reviewer should weigh most, e.g. delivery over depth in a communication round |

### Interviewer types

Every interview type is the same engine with different settings: a question folder, a persona, how hard it follows up, and what the review weighs. Some examples for `config.json`:

```json
{
  "personas": {
    "staff-frontend": { "label": "Staff frontend engineer", "text": "A staff frontend engineer. Cares about rendering, state, performance budgets and accessibility. Asks how things behave in the browser, not just what the API is." },
    "dba": { "label": "Database engineer", "text": "A senior database engineer. Digs into indexes, query plans, transactions, isolation levels and what happens under load." },
    "people-lead": { "label": "People lead", "text": "A warm but sharp people manager. Wants honest stories about conflict, feedback and ownership, with what the candidate personally did." }
  },
  "rounds": [
    { "id": "frontend", "label": "Frontend", "about": "React, CSS, browser performance, accessibility.", "mix": { "react": 3, "css": 1, "a11y": 1 }, "minutes": 25, "followUps": 2, "persona": "staff-frontend", "model": "fast", "job": "optional", "topicPick": true },
    { "id": "backend", "label": "Backend", "about": "APIs, queues, caching, failure handling.", "mix": { "nodejs": 2, "api-design": 2, "queues": 1 }, "minutes": 25, "followUps": 2, "persona": "cto", "model": "fast", "job": "optional", "topicPick": true },
    { "id": "databases", "label": "Databases", "about": "Postgres, indexing, transactions, scaling reads and writes.", "mix": { "postgres": 3, "data-modeling": 1 }, "minutes": 25, "followUps": 3, "persona": "dba", "model": "thinking", "job": "none", "instructions": "Ask for the query plan or the index they would add whenever it fits." },
    { "id": "system-design", "label": "System design", "about": "One design end to end.", "mix": { "system-design": 1 }, "minutes": 40, "followUps": 6, "persona": "bigtech", "model": "thinking", "job": "none", "only": "design-" },
    { "id": "soft-skills", "label": "Soft skills", "about": "Conflict, feedback, ownership, working across time zones.", "mix": { "behavioral": 4 }, "minutes": 20, "followUps": 2, "persona": "people-lead", "model": "fast", "job": "optional", "reviewFocus": "Judge the story: situation, what they personally did, the result, what they learned." },
    { "id": "communication", "label": "Communication", "about": "Short, clear spoken answers.", "mix": { "screening": 2, "behavioral": 2 }, "minutes": 15, "followUps": 1, "persona": "manager", "model": "fast", "job": "none", "reviewFocus": "Weigh structure and delivery (headline first, short sentences, no filler, a concrete example) more than depth." }
  ]
}
```

Add the matching folders under `questions/` (`questions/postgres/`, `questions/css/`, ...) and they show up on the start screen. The default config already has a communication round.

### Learn mode

Pick **Learn** on the start screen (or set `"defaultMode": "learn"` in `config.json` to make it the default). It turns the interviewer into a tutor:

1. It reads out the question, and the model answer from your question file appears on screen.
2. It teaches the answer in simple spoken words: the headline, the key points, an example. Ask any doubt ("why?", "give me an example", "explain again"); it answers from your notes and says so when the notes don't cover something.
3. When you say you're ready, it hides the answer and asks you to explain it back, as you would in an interview.
4. It tells you what you got and what you missed, lets you try once more, then moves on.

After the call, Claude grades only your explain-back answers (not your doubts) and updates spaced repetition, so the questions you struggled to explain come back sooner. Switch to **Interview** mode once the answers stick.

### Using an existing notes folder

Already keep interview notes somewhere else? Point the workspace at them instead of copying. Paths in `config.json` are relative to the workspace folder:

```json
{
  "paths": {
    "questions": "../qna",
    "profile": ["../resume.md", "../about-me.md"],
    "prep": "../qna/interviews",
    "reports": "reports"
  },
  "skip": { "folders": ["dsa", "interviews"], "files": "^(00-|playbook)" },
  "reviewNotes": ["Use numbers from resume.md only, never from the question files."]
}
```

| Field | Meaning |
|---|---|
| `paths` | Move any part: `questions`, `profile` (a folder or a list of files), `prep`, `sessions`, `reports`, `progress`, `coachNotes`, `interviewerNotes` |
| `skip.folders` | Question folders that are not spoken questions (code exercises, notes) |
| `skip.files` | A regular expression for question file names to skip |
| `reviewNotes` | Extra rules for the reviewer, added to Claude's prompt |

## Grading

With `ANTHROPIC_API_KEY` set, Claude (`claude-opus-5-5` by default, change it with `REVIEW_MODEL`) grades each call within a minute or two of ending it. It scores every main question from 1 to 10 on technical depth, structure and delivery. It writes the answer you should give next time using only facts from your profile. Then it updates the two notes files. The request uses server-side fallbacks, so if a safety check declines it, the same call retries on another model.

Without a key, grade by hand:

```bash
npm run review -- <session id> --prompt > prompt.txt   # paste into any Claude chat
# save the JSON it replies with as review.json, then:
curl -X POST localhost:4747/api/sessions/<session id>/review \
  -H 'content-type: application/json' --data @review.json
```

`npm run review -- <session id>` grades an ended session again (for example after an API error).

## Run it inside another app

The whole app is one Express router, so an existing dashboard can serve it under its own path, login and env:

```ts
import { createInterviewApp } from 'voice-interviewer'; // or a path to src/app.ts

app.use(
  '/interview',
  createInterviewApp({
    workspace: '/path/to/notes',          // sets WORKSPACE
    guard: requireLogin,                   // runs before starting a call, grading and debriefs
    onReview: (event) => notifyMe(event),  // after each review, or when grading fails
  }),
);
```

The page uses relative URLs, so it works under any prefix and behind a reverse proxy. A guard can answer `401` with `{ "error": "...", "unlock": "/login" }` and the page shows a **Sign in** link. The browser still needs `localhost` or HTTPS for the microphone.

Standalone, set `REVIEW_WEBHOOK_URL` to get the same review event as a JSON `POST`. To load settings from a different env file, set `DOTENV_CONFIG_PATH`.

## Cost

- **Gemini Live:** billed per minute of audio by Google. Check the current Live API pricing for your model.
- **Claude grading:** one request per call. Expect well under a dollar per session; it depends on the call length and the model you pick.

## Development

```bash
npm run dev        # server with reload (port 4747)
npm run dev:web    # page with hot reload on http://localhost:5173, API proxied to 4747
npm run check      # typecheck + tests (no network, no API keys needed)
```

| File | What it does |
|---|---|
| `src/app.ts` | The router: HTTP API, the built page, review hooks |
| `src/server.ts` | The standalone server around it |
| `src/sessions.ts` | Start, tool calls, end, metrics, review, report, debrief, cleanup |
| `src/interviewer.ts` | Gemini Live setup: system prompt, tools, voices, token |
| `src/bank.ts` | Question bank parsing, spaced repetition, picking questions |
| `src/review.ts` | Claude grading and the notes files |
| `src/workspace.ts` | Paths, `config.json`, private word filtering |
| `web/src/live.ts` | Browser audio (AudioWorklets) and the Gemini Live socket |
| `web/src/App.tsx` | The page: setup, live call, review |

The Gemini Live model names (`gemini-3.8-live` and the extended thinking variant) can be changed with `GEMINI_LIVE_MODEL` and `GEMINI_LIVE_THINKING_MODEL` when Google renames them.

## License

MIT
