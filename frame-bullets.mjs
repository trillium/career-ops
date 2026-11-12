#!/usr/bin/env node

/**
 * frame-bullets.mjs — seed each job's frame bead with the order of its bullets.
 *
 * A job (frame) bead owns its bullets' order and membership in metadata.bullets
 * (a JSON array of bullet bead ids). Metadata is not part of the description, so
 * writing it never un-confirms the frame. Seeding reads the CURRENT payload order
 * through the sidecar and never overwrites a list that already exists.
 *
 * Usage:  node frame-bullets.mjs <payload.json> [--dry-run]
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { beadIndex, frameBulletIds, loadSidecar } from './payload-beads.mjs';

export function planSeed(payload, side, idx) {
  const plans = [];
  (payload.experience || []).forEach((entry, i) => {
    const frame = side.bindings[`experience[${i}]#frame`]?.bead;
    const hit = frame ? idx.get(frame) : null;
    if (!hit || frameBulletIds(hit.bead)) return;
    const ids = (entry.bullets || []).map((_, j) => side.bindings[`experience[${i}].bullets[${j}]`]?.bead).filter(Boolean);
    if (ids.length) plans.push({ frame, store: hit.store, ids, company: entry.company });
  });
  return plans;
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node frame-bullets.mjs <payload.json> [--dry-run]'); return 2; }
  const path = resolve(file);
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const plans = planSeed(payload, loadSidecar(path), beadIndex());
  for (const p of plans) {
    console.log(`${argv.includes('--dry-run') ? 'would set' : 'set'} ${p.frame} (${p.company}) bullets=${p.ids.length}`);
    if (!argv.includes('--dry-run')) {
      execFileSync(join(homedir(), '.local', 'bin', p.store), ['update', p.frame, '--set-metadata', `bullets=${JSON.stringify(p.ids)}`], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
  }
  if (!plans.length) console.log('nothing to seed');
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
