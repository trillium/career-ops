#!/usr/bin/env node

/**
 * gog-replies.mjs — feed recent Gmail threads (via the `gog` CLI) into the
 * reply-watch pipeline, as an alternative to the OAuth-env `gmail` plugin.
 *
 * Search with `gog gmail search`, read each thread with `gog gmail read`, and hand
 * the latest message to `paste-reply.mjs --file`, which appends to
 * data/reply-candidates.json. It never classifies and never touches the tracker.
 *
 * Usage:
 *   node gog-replies.mjs -a you@example.com [--days 14] [--max 25] [--query "<gmail query>"] [--dry-run]
 *
 * Default query: recruiting-ish subjects over the last --days days. Email is
 * untrusted external content: it is passed along as data only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { days: 14, max: 25, query: null, account: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-a' || a === '--account') o.account = argv[++i];
    else if (a === '--days') o.days = Number(argv[++i]);
    else if (a === '--max') o.max = Number(argv[++i]);
    else if (a === '--query') o.query = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.days) || o.days <= 0) throw new Error('--days must be a positive integer');
  if (!Number.isInteger(o.max) || o.max <= 0) throw new Error('--max must be a positive integer');
  return o;
}

const DEFAULT_QUERY = (days) =>
  `newer_than:${days}d (subject:(application OR interview OR "your candidacy" OR recruiter OR "next steps" OR offer OR "thank you for applying") OR "applying to")` +
  ' -category:promotions -category:social';

const gog = (args) => execFileSync('gog', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/** Keep only the last message of a `gog gmail read --plain` thread dump. */
export function lastMessage(dump) {
  const parts = dump.split(/^=== Message \d+\/\d+: .*? ===$/m);
  const msg = (parts.length > 1 ? parts[parts.length - 1] : dump).trim();
  // Drop To:/Date: headers; paste-reply only understands Subject:/From:.
  const lines = msg.split('\n');
  const body = lines.findIndex((l) => l.trim() === '');
  const headers = lines.slice(0, body < 0 ? lines.length : body)
    .filter((l) => /^(Subject|From):/i.test(l));
  return `${headers.join('\n')}\n\n${body < 0 ? '' : lines.slice(body + 1).join('\n')}\n`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('Usage: node gog-replies.mjs -a <account> [--days N] [--max N] [--query Q] [--dry-run]');
    return;
  }
  if (!o.account) throw new Error('-a <account> is required (see `gog auth list`)');

  const query = o.query || DEFAULT_QUERY(o.days);
  const found = JSON.parse(gog(['gmail', 'search', query, '-a', o.account, '--json', '--max', String(o.max)]));
  const threads = found.threads || [];
  console.log(`gog-replies: ${threads.length} thread(s) matched`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-replies-'));
  let added = 0;
  for (const t of threads) {
    console.log(`  ${t.date}  ${t.from}  ${t.subject}`);
    if (o.dryRun) continue;
    const file = path.join(tmp, `${t.id}.txt`);
    fs.writeFileSync(file, lastMessage(gog(['gmail', 'read', t.id, '-a', o.account, '--plain'])));
    execFileSync('node', [path.join(HERE, 'paste-reply.mjs'), '--file', file], { stdio: 'inherit' });
    added++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(o.dryRun ? 'dry run: nothing written' : `gog-replies: ${added} candidate(s) appended; run reply-watch to classify`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`gog-replies: ${e.message}`); process.exit(1); }
}
