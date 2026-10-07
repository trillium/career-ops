#!/usr/bin/env node

/**
 * beads-to-cv.mjs — generate a cv.md-shaped file from a bead-backed resume.
 *
 * Beads are the master. cv.md becomes a generated view of one resume bead
 * (e.g. `resumes-tzu`), resolved by the copied resume-docx tooling in
 * local/resume-beads/ (gitignored). The run:
 *
 *   1. GATE   resume-gate.py <id>  — refuses (exit 5) if any used bead is
 *             unconfirmed or stale. `--draft` skips this and stamps a DRAFT banner.
 *   2. DATA   resume-data.py <id>  — structured JSON resolved live from beads,
 *             including `bead_map` (bullet text -> bead id), added in the copy.
 *   3. RENDER cv.md-shaped markdown + a sidecar cv.beads.json mapping every
 *             bullet's exact text to its bead, so payload bullets can carry an
 *             exact `bead` reference (read first by resume-beads.mjs).
 *
 * Default output is output/cv.from-beads.md (+ output/cv.beads.json). cv.md is
 * only replaced with --write, after a cv.md.bak backup.
 *
 * Usage:
 *   node beads-to-cv.mjs <resume-bead-id>
 *   node beads-to-cv.mjs <resume-bead-id> --draft
 *   node beads-to-cv.mjs <resume-bead-id> --write
 *
 * Env: RESUME_PY (python with PyYAML), RESUME_PII_DIR (default ~/code/resume-docx/pii).
 * Exit: 0 ok · 2 usage · 4 resolve failed · 5 gate blocked.
 */

import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(ROOT, 'local', 'resume-beads');
const PY = process.env.RESUME_PY || join(homedir(), '.pyenv/shims/python3');

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const ids = argv.filter((a) => !a.startsWith('--'));
  return { id: ids[0], draft: flags.has('--draft'), write: flags.has('--write') };
}

export function renderCv(data) {
  const sidecar = {};
  const out = [];
  const h = data.header || {};
  out.push(`# ${h.name || ''}`, '');
  if (h.title) out.push(h.title, '');
  const contacts = (h.contacts || []).map((c) => `[${c.label}](${c.url})`);
  if (contacts.length) out.push(contacts.join(' · '), '');

  if (data.summary) out.push('## Summary', '', data.summary, '');
  if (data.skills) out.push('## Technical Skills', '', data.skills, '');

  const section = (title, entries) => {
    if (!entries?.length) return;
    out.push(`## ${title}`, '');
    for (const e of entries) {
      out.push(`### ${e.title}${e.org ? ` — ${e.org}` : ''}`, '');
      if (e.meta) out.push(`*${e.meta}*`, '');
      for (const b of e.bullets || []) {
        out.push(`- ${b}`);
        const ref = data.bead_map?.[b];
        if (ref?.id) sidecar[b] = ref;
      }
      out.push('');
    }
  };
  section('Experience', data.experience);
  section('Projects', data.projects);

  if (data.education?.length) {
    out.push('## Education', '', ...data.education.map((l) => `- ${l}`), '');
  }
  return { markdown: out.join('\n'), sidecar };
}

function main() {
  const { id, draft, write } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('usage: node beads-to-cv.mjs <resume-bead-id> [--draft] [--write]');
    return 2;
  }
  if (!existsSync(join(TOOLS, 'resume-data.py'))) {
    console.error(`✗ ${TOOLS} missing — the copied resume-docx tooling is not installed`);
    return 4;
  }

  const gate = spawnSync(PY, [join(TOOLS, 'resume-gate.py'), id], { encoding: 'utf8' });
  const gated = gate.status === 0;
  if (!gated && !draft) {
    process.stderr.write(gate.stdout || '');
    console.error(`\n✗ GATE BLOCKED for ${id} — nothing written. Confirm the beads, or pass --draft.`);
    return 5;
  }

  let raw;
  try {
    raw = execFileSync(PY, [join(TOOLS, 'resume-data.py'), id], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`✗ resume-data failed for ${id}\n${e.stderr || e.message}`);
    return 4;
  }

  const { markdown, sidecar } = renderCv(JSON.parse(raw));
  const banner = gated
    ? `<!-- GENERATED from bead ${id} by beads-to-cv.mjs. Edit the beads, not this file. -->\n\n`
    : `<!-- DRAFT: gate FAILED for ${id}; contains unconfirmed beads. Do not send. -->\n\n`;

  mkdirSync(join(ROOT, 'output'), { recursive: true });
  const mdPath = join(ROOT, 'output', 'cv.from-beads.md');
  const sidePath = join(ROOT, 'output', 'cv.beads.json');
  writeFileSync(mdPath, banner + markdown);
  writeFileSync(sidePath, JSON.stringify({ resume: id, gated, beads: sidecar }, null, 2) + '\n');
  console.log(`✓ ${mdPath}\n✓ ${sidePath} (${Object.keys(sidecar).length} bullets mapped)`);

  if (write) {
    if (!gated) {
      console.error('✗ --write refused: gate did not pass');
      return 5;
    }
    const cv = join(ROOT, 'cv.md');
    if (existsSync(cv)) copyFileSync(cv, `${cv}.bak`);
    writeFileSync(cv, banner + markdown);
    console.log(`✓ cv.md replaced (backup: cv.md.bak)`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
