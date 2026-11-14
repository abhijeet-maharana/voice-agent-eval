import 'dotenv/config';
import { liveConfig, liveModels, liveSetup, mintToken } from '../src/interviewer';
import type { LiveModelId } from '../src/types';

/**
 * npm run smoke:live [thinking|fast]: opens a real Gemini Live session the way the page does (short-lived
 * token, the same setup builder), asks the model to call one tool, answers it, and checks the model then says
 * the question from the result. Uses GEMINI_API_KEY from .env (or DOTENV_CONFIG_PATH). Costs a few seconds of
 * Live usage. Exit code 0 = it works, 1 = it does not (the reason is printed).
 */

const choice = (process.argv[2] ?? 'thinking') as LiveModelId;
const models = liveModels();
if (!(choice in models)) {
  console.error(`Pick one of: ${Object.keys(models).join(', ')}`);
  process.exit(2);
}
const QUESTION = 'What is a closure in JavaScript?';
const TIMEOUT_MS = 60_000;

// Diagnosis knobs: SMOKE_TOOL_PARAMS=1 gives the tool a parameter schema; SMOKE_ENDPOINT=key-v1beta|key-v1alpha
// connects with the API key itself (server side only, never from the page) instead of a short-lived token.
const tools = [
  {
    name: 'next_question',
    description: 'Get the next interview question. Call it before asking anything.',
    ...(process.env.SMOKE_TOOL_PARAMS ? { parameters: { type: 'OBJECT', properties: { topic: { type: 'STRING', description: 'Optional topic.' } } } } : {}),
  },
];
const instruction = 'You are a voice interviewer. Start by calling next_question, then ask the candidate exactly the question it returns, in one sentence, and stop.';
const { setup } = liveSetup(models[choice].model, instruction, tools, liveConfig().voice, undefined, { thinking: choice === 'thinking' });

const started = Date.now();
const log = (event: string, detail = '') => console.log(`+${((Date.now() - started) / 1000).toFixed(1)}s ${event}${detail ? `  ${detail}` : ''}`);

function finish(ok: boolean, verdict: string): never {
  console.log(`\n${ok ? 'PASS' : 'FAIL'} (${models[choice].model}): ${verdict}`);
  process.exit(ok ? 0 : 1);
}

const endpoint = process.env.SMOKE_ENDPOINT ?? 'token';
let url: string;
if (endpoint === 'token') {
  const token = await mintToken(5).catch((err: Error) => finish(false, `could not mint a token: ${err.message}`));
  log('token minted');
  url = `${liveConfig().wsUrl}?access_token=${encodeURIComponent(token)}`;
} else {
  const version = endpoint === 'key-v1alpha' ? 'v1alpha' : 'v1beta';
  url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY ?? '')}`;
  log('endpoint', `API key, ${version} BidiGenerateContent`);
}
const ws = new WebSocket(url);
let toolCalled = false;
let spoken = '';

const timer = setTimeout(() => {
  if (!toolCalled) finish(false, `no tool call within ${TIMEOUT_MS / 1000}s. The model spoke: "${spoken.trim() || '(nothing)'}"`);
  finish(false, `the tool was called but the question was not said within ${TIMEOUT_MS / 1000}s. The model spoke: "${spoken.trim()}"`);
}, TIMEOUT_MS);

ws.onopen = () => {
  log('socket open', `setup sent for ${setup.model}, tools ${(setup.tools[0].functionDeclarations as { name: string; behavior: string }[]).map((t) => `${t.name}:${t.behavior}`).join(', ')}`);
  ws.send(JSON.stringify({ setup }));
};
ws.onerror = () => log('socket error');
ws.onclose = (e) => {
  clearTimeout(timer);
  finish(false, `Gemini closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
};
ws.onmessage = async (e) => {
  const text = typeof e.data === 'string' ? e.data : Buffer.from(await (e.data as Blob).arrayBuffer()).toString('utf8');
  const msg = JSON.parse(text);
  if (msg.setupComplete) {
    log('setup complete');
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '(The candidate has joined. Start now.)' }] }], turnComplete: true } }));
    return;
  }
  if (process.env.SMOKE_VERBOSE) {
    const parts = (msg.serverContent?.modelTurn?.parts ?? []).map((p: Record<string, unknown>) => Object.keys(p).join('+'));
    log('message', `${Object.keys(msg).join(',')}${msg.serverContent ? ` [${Object.keys(msg.serverContent).join(',')}]` : ''}${parts.length ? ` parts: ${parts.join(',')}` : ''}`);
  }
  const c = msg.serverContent;
  if (c?.outputTranscription?.text) spoken += c.outputTranscription.text;
  if (c?.turnComplete || c?.interactionStatus) log(c.turnComplete ? 'turn complete' : 'status', [c.interactionStatus, spoken ? `said so far: "${spoken.trim().slice(-120)}"` : ''].filter(Boolean).join(' · '));
  const calls = msg.toolCall?.functionCalls as { id?: string; name: string }[] | undefined;
  if (calls?.length) {
    toolCalled = true;
    log('tool call', calls.map((x) => x.name).join(', '));
    ws.send(JSON.stringify({ toolResponse: { functionResponses: calls.map((x) => ({ id: x.id, name: x.name, response: { question: QUESTION } })) } }));
    log('tool response sent');
  }
  if (toolCalled && /closure/i.test(spoken)) {
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
    finish(true, `it called next_question and asked the question from the result: "${spoken.trim().slice(-160)}"`);
  }
};
