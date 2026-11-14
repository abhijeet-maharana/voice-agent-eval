import fs from 'node:fs';
import path from 'node:path';

// npm run setup: copies examples/workspace to ./workspace (or $WORKSPACE) and .env.example to .env,
// never overwriting anything that is already there.

const root = process.cwd();
const target = path.resolve(process.env.WORKSPACE || 'workspace');
const example = path.join(root, 'examples', 'workspace');

if (fs.existsSync(target)) {
  console.log(`Workspace already exists: ${target} (left as it is)`);
} else {
  fs.cpSync(example, target, { recursive: true });
  console.log(`Created ${target} from examples/workspace. Replace the sample profile and questions with your own.`);
}

const env = path.join(root, '.env');
if (fs.existsSync(env)) console.log('.env already exists (left as it is)');
else {
  fs.copyFileSync(path.join(root, '.env.example'), env);
  console.log('Created .env. Add GEMINI_API_KEY (required) and ANTHROPIC_API_KEY (for grading).');
}
