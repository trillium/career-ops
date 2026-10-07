#!/usr/bin/env node

/**
 * beads-list.mjs — the complete résumé bead pool, with confirmation status.
 *
 * Reads every résumé-relevant federated store (resume_bullets, projects,
 * employment, education, career) and reports each bead's REAL approval state,
 * recomputed from the bead's current text (see classifyBead in
 * resume-beads.mjs): CONFIRMED, STALE (edited since confirmed), or UNCONFIRMED.
 *
 * Read-only. Never writes, never confirms.
 *
 * Usage:
 *   node beads-list.mjs                          # table + per-store tally
 *   node beads-list.mjs --status=unconfirmed     # confirmed|unconfirmed|stale
 *   node beads-list.mjs --stores=resume_bullets,employment
 *   node beads-list.mjs --json
 *   node beads-list.mjs --md [--out=pool.md]     # the whole pool as ONE merged markdown file
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { classifyBead, readStore } from './resume-beads.mjs';

const ALL_STORES = ['resume_bullets', 'projects', 'employment', 'education', 'career'];
const MARK = { CONFIRMED: '✅', STALE: '⚠️', UNCONFIRMED: '❌' };
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function loadPool(stores = ALL_STORES) {
  const rows = [];
  const failures = [];
  for (const store of stores) {
    const r = readStore(store);
    if (!r.ok) {
      failures.push(`${store}: ${r.reason}`);
      continue;
    }
    for (const bead of r.beads) {
      const c = classifyBead(bead);
      rows.push({
        id: bead.id,
        store,
        status: c.status,
        inertConfirmedLabel: Boolean(c.inertConfirmedLabel),
        title: bead.title || '',
        labels: (bead.labels || []).filter((l) => !String(l).startsWith('confirmed:')),
        text: String(bead.description || bead.title || '').trim(),
        beadStatus: bead.status,
      });
    }
  }
  return { rows, failures };
}

function tally(rows) {
  const t = {};
  for (const r of rows) {
    t[r.store] ??= { CONFIRMED: 0, STALE: 0, UNCONFIRMED: 0 };
    t[r.store][r.status] += 1;
  }
  return t;
}

export function renderMerged(rows) {
  const out = ['# Résumé bead pool', '', `${rows.length} beads · ✅ confirmed · ⚠️ stale (edited since confirmed) · ❌ unconfirmed`, ''];
  for (const store of ALL_STORES) {
    const mine = rows.filter((r) => r.store === store);
    if (!mine.length) continue;
    out.push(`## ${store} (${mine.length})`, '');
    for (const r of mine) {
      const flag = r.inertConfirmedLabel ? ' — bare `confirmed` label, ignored by the gate' : '';
      out.push(`### ${MARK[r.status]} ${r.id} — ${collapse(r.title).slice(0, 100)}`, '');
      if (r.labels.length) out.push(`labels: ${r.labels.join(', ')}${flag}`, '');
      out.push(r.text, '');
    }
  }
  return out.join('\n');
}

function main(argv) {
  let stores = ALL_STORES;
  let status = null;
  let asJson = false;
  let md = false;
  let outPath = null;
  for (const a of argv) {
    if (a === '--json') asJson = true;
    else if (a === '--md') md = true;
    else if (a.startsWith('--out=')) outPath = a.split('=')[1];
    else if (a.startsWith('--status=')) status = a.split('=')[1].toUpperCase();
    else if (a.startsWith('--stores=')) stores = a.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`ERROR: unknown argument: ${a}`);
      return 1;
    }
  }
  if (status && !['CONFIRMED', 'STALE', 'UNCONFIRMED'].includes(status)) {
    console.error('ERROR: --status must be confirmed, stale or unconfirmed');
    return 1;
  }

  const { rows: all, failures } = loadPool(stores);
  const rows = status ? all.filter((r) => r.status === status) : all;
  for (const f of failures) console.error(`WARN: skipped store — ${f}`);

  if (md) {
    const text = renderMerged(rows);
    if (outPath) {
      writeFileSync(outPath, text + '\n');
      console.error(`✓ ${outPath} (${rows.length} beads)`);
    } else console.log(text);
    return 0;
  }
  if (asJson) {
    console.log(JSON.stringify({ tally: tally(all), beads: rows }, null, 2));
    return 0;
  }

  for (const r of rows) {
    const labels = r.labels.filter((l) => /^(employer|company|project|role):/.test(l)).join(' ');
    const flag = r.inertConfirmedLabel ? ' (bare confirmed label)' : '';
    console.log(`${MARK[r.status]} ${r.id.padEnd(22)} ${r.store.padEnd(15)} ${labels.padEnd(28)} ${collapse(r.text).slice(0, 80)}${flag}`);
  }
  console.log('');
  for (const [store, t] of Object.entries(tally(all))) {
    console.log(`${store.padEnd(15)} ✅ ${t.CONFIRMED}  ⚠️ ${t.STALE}  ❌ ${t.UNCONFIRMED}`);
  }
  return 0;
}

// exitCode, not process.exit(): exiting immediately truncates large piped stdout.
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
