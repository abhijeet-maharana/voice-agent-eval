import 'dotenv/config';
import fs from 'node:fs';
import express from 'express';
import { createInterviewApp } from './app';
import { gradingConfigured } from './review';
import { workspaceDir } from './workspace';

/**
 * The standalone app: the router from app.ts at the root of a local server. It binds to 127.0.0.1 by
 * default. The microphone works on localhost without HTTPS; there is no login, so do not expose it on a
 * network. Settings come from .env (or the file named by DOTENV_CONFIG_PATH) and the environment.
 */

const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(createInterviewApp());

app.listen(PORT, HOST, () => {
  const local = HOST === '0.0.0.0' || HOST === '127.0.0.1' ? 'localhost' : HOST;
  console.log(`voice-interviewer on http://${local}:${PORT}`);
  console.log(`  workspace: ${workspaceDir()}${fs.existsSync(workspaceDir()) ? '' : ' (missing: run "npm run setup")'}`);
  console.log(`  live interviewer: ${process.env.GEMINI_API_KEY ? 'on' : 'off (set GEMINI_API_KEY in .env)'}`);
  console.log(`  grading with Claude: ${gradingConfigured() ? 'on' : 'off (set ANTHROPIC_API_KEY in .env, or grade by hand)'}`);
});
