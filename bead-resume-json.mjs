#!/usr/bin/env node

/**
 * bead-resume-json.mjs — a bead-backed resume as JSON, in one step.
 *
 *   bun bead-resume-json.mjs <payload.json> --resume=<id>   the resolved resume, same path as the page and sync-payload
 *   node bead-resume-json.mjs <resume-id>          build-cv-html.mjs payload shape (legacy, ignores job bullet lists)
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
  const resumeArg = args.find((a) => a.startsWith('--resume='));
  if (id && resumeArg) {
    const { resolveLive } = await import('./lavish-live.mjs');
    const json = `${JSON.stringify(resolveLive(id, resumeArg.slice(9)).payload, null, 2)}\n`;
    const target = (args.find((a) => a.startsWith('--to-bead=')) || '').slice(10);
    if (target) {
      // Readers that only have bead-reading tools get the export from this bead.
      execFileSync(join(homedir(), '.local', 'bin', target.replace(/-[^-]+$/, '')), ['update', target, '--description', json], { encoding: 'utf8' });
      console.error(`wrote export to ${target}`);
    } else process.stdout.write(json);
    process.exit(0);
  }
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
