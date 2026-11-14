import 'dotenv/config';
import { gradeSession, reviewPrompt } from '../src/review';

// npm run review -- <session id>            grade an ended session with Claude now
// npm run review -- <session id> --prompt   print the review prompt instead (paste it into any Claude chat)

const [id, flag] = process.argv.slice(2);
if (!id) {
  console.error('Usage: npm run review -- <session id> [--prompt]');
  process.exit(1);
}
if (flag === '--prompt') {
  console.log(reviewPrompt(id));
} else {
  const r = await gradeSession(id);
  console.log(`${id}: ${r.overall}/10. Report: ${r.report}`);
  if (r.bugs.length) console.log(`Interviewer bugs:\n- ${r.bugs.join('\n- ')}`);
}
