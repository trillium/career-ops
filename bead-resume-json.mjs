#!/usr/bin/env node

/**
 * bead-resume-json.mjs — a bead-backed resume as JSON, in one step.
 *
 *   node bead-resume-json.mjs <resume-id>          build-cv-html.mjs payload shape
 *   node bead-resume-json.mjs <resume-id> --raw    resume-data.py shape (docx-oriented)
 *
 * Env: RESUME_PY (python with PyYAML). Exit: 0 ok · 2 usage · 4 resolve failed.
 */

import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { toPayload } from './resume-data-to-payload.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_PY = join(ROOT, 'local', 'resume-beads', 'resume-data.py');
const PY = process.env.RESUME_PY || join(homedir(), '.pyenv/shims/python3');

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('usage: node bead-resume-json.mjs <resume-id> [--raw]');
    process.exit(2);
  }
  let raw;
  try {
    raw = execFileSync(PY, [DATA_PY, id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    process.exit(4);
  }
  const out = args.includes('--raw') ? JSON.parse(raw) : toPayload(JSON.parse(raw));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
