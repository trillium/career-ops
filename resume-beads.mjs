#!/usr/bin/env node

/**
 * resume-beads.mjs — which beads were used to make this CV, and are they approved?
 *
 * The reverse of the résumé pipeline. Everything else in career-ops flows
 * cv.md -> payload -> HTML -> PDF; nothing could answer "which bead is this
 * bullet?" or "has a human approved this wording?". The resume-docx side can
 * answer both (resume-gate.py resolves a resume bead's atoms -> beads, and
 * gates the build on them), but it resolves ITS manifest, not a career-ops
 * artifact — and a career-ops payload carries no bead reference at all.
 *
 * So this reads a career-ops tailored-CV payload and, for every bullet and
 * section, reports the bead behind it plus that bead's REAL approval state.
 *
 * Approval state is recomputed here rather than trusted from a label's
 * presence, mirroring ~/code/resume-docx/gate_lib.py:
 *
 *   CONFIRMED    a `confirmed:<sha1(description)[:12]>` label matching the
 *                bead's CURRENT text
 *   STALE        a `confirmed:<hash>` label exists but the text has been edited
 *                since — the hash is bound to the wording, so editing a bullet
 *                revokes its approval on its own with no un-confirm step
 *   UNCONFIRMED  no confirmation
 *
 * This file also detects a trap gate_lib.py cannot see: a BARE `confirmed`
 * label, with no hash. `confirmed_hashes()` only collects labels starting with
 * `confirmed:`, so a bare one contributes nothing and the bead still reads
 * UNCONFIRMED — while looking approved to anyone skimming labels. Two such
 * beads existed on 2026-10-07 (resume_bullets-rzy6, resume_bullets-rzy6.2),
 * both carrying the text of the CV then under review.
 *
 * ── How the bead is found (and why the answer is best-effort) ────────────────
 *
 * PREFERRED: an explicit bead reference written into the payload — a `bead`
 * field on a bullet or on a section entry. No payload emitted today carries
 * one, but the check is here first so that adding the field is all it takes to
 * make the mapping exact, exactly as the resume-docx restyled JSON already
 * does with its per-bullet `bead` field.
 *
 * FALLBACK: text matching against the federated bead stores, scored by
 * containment (how much of the SHORTER text is shared) plus a floor on shared
 * substantive tokens. This is a heuristic and is labelled as one in the output,
 * because a text match can be wrong in both directions: reword a bullet and it
 * stops matching, and two sibling variants of one claim (per-company copies)
 * both match the same bullet.
 *
 * READ-ONLY. Never writes a bead, never confirms anything, never runs the gate.
 *
 * Usage:
 *   node resume-beads.mjs <payload.json>
 *   node resume-beads.mjs <payload.json> --summary
 *   node resume-beads.mjs <payload.json> --json
 *   node resume-beads.mjs <payload.json> --strict        # exit 1 unless every used bead is CONFIRMED
 *   node resume-beads.mjs <payload.json> --min-containment=0.5 --stores=resume_bullets,projects
 *   node resume-beads.mjs --self-test
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { extractFromPayload } from './cv-duplicate-check.mjs';

const CONFIRM_PREFIX = 'confirmed:';
const STORE_BIN = join(homedir(), '.local', 'bin');

/** The stores ~/code/resume-docx/gate_lib.py resolves a resume against. */
const DEFAULT_STORES = ['resume_bullets', 'projects', 'employment', 'education', 'career'];

const CONFIRMED = 'CONFIRMED';
const STALE = 'STALE';
const UNCONFIRMED = 'UNCONFIRMED';

const STOPWORDS = new Set([
  'a', 'an', 'about', 'above', 'across', 'after', 'again', 'all', 'also', 'and',
  'another', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'every', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here',
  'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'of', 'off', 'on',
  'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'per', 'same',
  'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'until', 'up', 'us', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'within',
  'would', 'you', 'your',
]);

export function hashOf(description) {
  if (typeof description !== 'string') return null;
  return createHash('sha1').update(description, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Classify a bead against its CURRENT text. Mirrors gate_lib.classify_bead,
 * including its fail-closed behaviour: an unreadable bead, a missing
 * description, or an unhashable description is UNCONFIRMED, never a pass.
 */
export function classifyBead(bead) {
  const out = {
    status: UNCONFIRMED,
    currentHash: null,
    confirmedHash: null,
    inertConfirmedLabel: false,
  };
  if (!bead || typeof bead !== 'object') return out;

  const labels = (bead.labels || []).map(String);
  const hashed = labels
    .filter((l) => l.startsWith(CONFIRM_PREFIX))
    .map((l) => l.slice(CONFIRM_PREFIX.length))
    .filter(Boolean);
  // A label that is exactly "confirmed" is inert: gate_lib only reads
  // `confirmed:<hash>`. Flag it, because it reads as approval and is not.
  out.inertConfirmedLabel = labels.includes('confirmed') && hashed.length === 0;

  const desc = bead.description;
  const cur = hashOf(desc);
  if (cur === null) return out;
  out.currentHash = cur;

  if (hashed.includes(cur)) {
    out.status = CONFIRMED;
    out.confirmedHash = cur;
  } else if (hashed.length > 0) {
    out.status = STALE;
    out.confirmedHash = hashed[0];
  }
  return out;
}

// ── text matching ───────────────────────────────────────────────────────────

function normalizeText(input) {
  return String(input)
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/(\d),(?=\d)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9+#%./\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(text) {
  return new Set(
    normalizeText(text)
      .split(' ')
      .map((t) => t.replace(/^[./-]+|[./-]+$/g, ''))
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function containment(a, b) {
  const small = Math.min(a.size, b.size);
  if (small === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / small;
}

function sharedCount(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** Read one federated store's beads. Fail-soft: an unreadable store is skipped. */
export function readStore(store, { timeout = 60000 } = {}) {
  const exe = join(STORE_BIN, store);
  if (!existsSync(exe)) return { store, ok: false, reason: `no wrapper at ${exe}`, beads: [] };
  try {
    const out = execFileSync(exe, ['list', '--json'], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(out || '[]');
    if (!Array.isArray(parsed)) return { store, ok: false, reason: 'list --json was not an array', beads: [] };
    return { store, ok: true, beads: parsed };
  } catch (err) {
    return { store, ok: false, reason: err.message.split('\n')[0], beads: [] };
  }
}

export function loadCorpus(stores) {
  const corpus = [];
  const failures = [];
  for (const store of stores) {
    const r = readStore(store);
    if (!r.ok) {
      failures.push(`${store}: ${r.reason}`);
      continue;
    }
    for (const bead of r.beads) {
      const text = `${bead.title || ''}\n${bead.description || ''}`;
      corpus.push({
        id: bead.id,
        store,
        title: bead.title || '',
        tokens: tokensOf(text),
        // Matching targets the DESCRIPTION for bullets (the bullet text lives
        // there) and the TITLE for frames (the frame's identity lives there).
        titleTokens: tokensOf(bead.title || ''),
        isFrame: /frame/i.test(bead.title || '') || /\bposition:/.test(bead.description || ''),
        isResumeBullet: store === 'resume_bullets'
          || (bead.labels || []).some((l) => l === 'resume-bullet' || l === 'resume_bullet'),
        ...classifyBead(bead),
      });
    }
  }
  return { corpus, failures };
}

function match(tokens, corpus, { minContainment, minShared, framesOnly = false }) {
  const hits = [];
  for (const c of corpus) {
    if (framesOnly && !c.isFrame) continue;
    if (tokens.size === 0 || c.tokens.size === 0) continue;
    const shared = sharedCount(tokens, c.tokens);
    if (shared < minShared) continue;
    const cont = containment(tokens, c.tokens);
    if (cont < minContainment) continue;
    hits.push({ ...c, containment: Number(cont.toFixed(3)), shared });
  }
  if (hits.length === 0) return [];
  // A tie band rather than a single winner: per-company sibling variants of one
  // claim (company:quipli / company:adobe copies) score identically, and
  // silently picking one would invent a precision that isn't there.
  const top = Math.max(...hits.map((h) => h.containment));
  const band = hits.filter((h) => h.containment >= top - 0.05);
  // Within the band, a bullet-shaped bead wins. Without this, a career-summary
  // bead can outscore the actual bullet bead on shared vocabulary alone —
  // 'AI & Agent Systems: MCP servers, ...' matched a Coder career summary at
  // 0.92 while the real section:technical bead sat at 0.90.
  band.sort((x, y) =>
    Number(y.isResumeBullet) - Number(x.isResumeBullet) ||
    y.containment - x.containment ||
    y.shared - x.shared);
  return band.slice(0, 3);
}

export function mapPayload(payload, corpus, options = {}) {
  const minContainment = options.minContainment ?? 0.55;
  const minShared = options.minShared ?? 4;
  const units = extractFromPayload(payload);
  const rows = [];

  for (const u of units) {
    const tokens = tokensOf(u.text);
    // Exact path: the bullet's text is verbatim in the beads-to-cv.mjs sidecar,
    // so the bead is known, not guessed.
    const known = options.sidecar?.get(normalizeText(u.text));
    const exact = known ? corpus.find((c) => c.id === known.id) : null;
    const hits = exact
      ? [{ ...exact, containment: 1, shared: tokens.size, exact: true }]
      : match(tokens, corpus, { minContainment, minShared });
    rows.push({
      ref: u.ref,
      section: u.section,
      kind: u.kind,
      text: u.text,
      beads: hits.map((h) => ({
        id: h.id,
        store: h.store,
        title: h.title,
        status: h.status,
        inertConfirmedLabel: h.inertConfirmedLabel,
        containment: h.containment,
      })),
    });
  }

  // Frames: the per-section bead that carries position/company/location.
  const frames = [];
  for (const [i, e] of (payload.experience || []).entries()) {
    if (!e || typeof e !== 'object') continue;
    const label = [e.company, e.role, e.location].filter(Boolean).join(' - ');
    const hits = match(tokensOf(label), corpus, {
      minContainment: options.minFrameContainment ?? 0.5,
      minShared,
      framesOnly: true,
    });
    frames.push({
      ref: `experience[${i}]`,
      section: e.company || `entry ${i}`,
      label,
      beads: hits.map((h) => ({
        id: h.id, store: h.store, title: h.title, status: h.status,
        inertConfirmedLabel: h.inertConfirmedLabel, containment: h.containment,
      })),
    });
  }

  const used = new Map();
  for (const row of rows) for (const b of row.beads) {
    if (!used.has(b.id)) used.set(b.id, { ...b, refs: [] });
    used.get(b.id).refs.push(row.ref);
  }
  for (const f of frames) for (const b of f.beads) {
    if (!used.has(b.id)) used.set(b.id, { ...b, refs: [] });
    used.get(b.id).refs.push(`${f.ref} (frame)`);
  }

  const tally = { [CONFIRMED]: 0, [STALE]: 0, [UNCONFIRMED]: 0 };
  for (const b of used.values()) tally[b.status] += 1;

  return {
    rows,
    frames,
    beads: [...used.values()].sort((a, b) => a.id.localeCompare(b.id)),
    tally,
    unmappedRows: rows.filter((r) => r.beads.length === 0).map((r) => r.ref),
    inert: [...used.values()].filter((b) => b.inertConfirmedLabel).map((b) => b.id),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const SYM = { [CONFIRMED]: '✓', [STALE]: '✗', [UNCONFIRMED]: '✗' };

function truncate(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

function printReport(file, result, failures) {
  console.log(`Bead map: ${file}`);
  if (failures.length) console.log(`Stores unreadable (skipped): ${failures.join('; ')}`);
  console.log('');

  for (const row of result.rows) {
    const mark = row.beads.length === 0 ? '—' : (row.beads[0].inertConfirmedLabel ? '⚠' : SYM[row.beads[0].status]);
    console.log(`${mark} ${row.ref}`);
    console.log(`   ${truncate(row.text, 96)}`);
    if (row.beads.length === 0) {
      console.log('   └─ no bead matched — sourced from cv.md, or no bead exists for this text');
    }
    for (const b of row.beads) {
      const weak = b.containment < 0.65 ? '  (weak — verify by hand)' : '';
      const inert = b.inertConfirmedLabel ? '  ⚠ bare `confirmed` label is INERT — the gate ignores it' : '';
      console.log(`   └─ ${b.id.padEnd(22)} [${b.status.padEnd(11)}] containment ${b.containment.toFixed(2)}  ${truncate(b.title, 40)}${weak}${inert}`);
    }
  }

  if (result.frames.length) {
    console.log('\n── section frames (position/company/location beads)');
    for (const f of result.frames) {
      const got = f.beads.length === 0
        ? 'no frame bead matched'
        : f.beads.map((b) => `${b.id} [${b.status}]`).join(', ');
      console.log(`   ${f.ref}  ${truncate(f.section, 44).padEnd(46)} ${got}`);
    }
  }

  console.log('\n' + '─'.repeat(78));
  const n = result.beads.length;
  console.log(`DISTINCT BEADS: ${n}   ✓ ${result.tally[CONFIRMED]} CONFIRMED   ✗ ${result.tally[STALE]} STALE   ✗ ${result.tally[UNCONFIRMED]} UNCONFIRMED`);
  console.log(`Bullets with no bead: ${result.unmappedRows.length}${result.unmappedRows.length ? ` (${result.unmappedRows.join(', ')})` : ''}`);
  if (result.inert.length) {
    console.log(`⚠ INERT \`confirmed\` label on: ${result.inert.join(', ')}`);
    console.log('  A bare `confirmed` label with no :<hash> contributes nothing — the gate reads');
    console.log('  only confirmed:<sha1(text)[:12]>. These beads are NOT approved despite looking so.');
  }
  console.log('');
  console.log('Bead ids were resolved by TEXT MATCHING, because the payload carries no bead');
  console.log('reference. That is a heuristic: rewording a bullet breaks the match, and');
  console.log('per-company sibling variants of one claim all match the same bullet (shown');
  console.log('together, in their tie band). Recorded linkage — a `bead` field in the payload —');
  console.log('would make this exact; this tool prefers it automatically once it exists.');
  console.log('READ-ONLY: nothing was confirmed and no bead was written.');
}

function printSummary(file, result) {
  console.log(`${file}\tbeads=${result.beads.length}\tconfirmed=${result.tally[CONFIRMED]}\tstale=${result.tally[STALE]}\tunconfirmed=${result.tally[UNCONFIRMED]}\tunmapped=${result.unmappedRows.length}${result.inert.length ? `\tinert=${result.inert.join('|')}` : ''}`);
}

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const check = (label, actual, expected) => {
    assertions += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures += 1;
      console.error(`FAIL: ${label}`);
      console.error(`  expected: ${JSON.stringify(expected)}`);
      console.error(`  actual:   ${JSON.stringify(actual)}`);
    }
  };

  // Hash parity with gate_lib.py's sha1(description)[:12].
  check('hash of "abc"', hashOf('abc'), 'a9993e364706');

  const text = 'Built talon_mcp, an MCP server connecting Talon Voice to AI coding assistants.';
  const h = hashOf(text);
  check('CONFIRMED on matching hash', classifyBead({ description: text, labels: [`confirmed:${h}`] }).status, CONFIRMED);
  check('STALE on edited text', classifyBead({ description: text, labels: ['confirmed:000000000000'] }).status, STALE);
  check('STALE records the old hash', classifyBead({ description: text, labels: ['confirmed:000000000000'] }).confirmedHash, '000000000000');
  check('UNCONFIRMED with no label', classifyBead({ description: text, labels: [] }).status, UNCONFIRMED);
  check('UNCONFIRMED when bead unreadable (fail-closed)', classifyBead(null).status, UNCONFIRMED);
  check('UNCONFIRMED when description missing (fail-closed)', classifyBead({ labels: ['confirmed:abc'] }).status, UNCONFIRMED);

  // The trap: looks approved, is not.
  const bare = classifyBead({ description: text, labels: ['confirmed', 'draft'] });
  check('bare `confirmed` is UNCONFIRMED', bare.status, UNCONFIRMED);
  check('bare `confirmed` is flagged inert', bare.inertConfirmedLabel, true);
  check('a real hash is not flagged inert', classifyBead({ description: text, labels: [`confirmed:${h}`] }).inertConfirmedLabel, false);

  // Matching behaviour.
  const corpus = [
    { id: 'rb-a', store: 'resume_bullets', title: 'Assumed stewardship of an open-source platform', tokens: tokensOf('Contributed to Cursorless with 4 merged PRs spanning editor features, docs infrastructure, and visual regression testing, plus an ongoing animated example generator for command documentation'), titleTokens: new Set(), isFrame: false, ...classifyBead({ description: 'x', labels: [] }) },
    { id: 'rb-b', store: 'resume_bullets', title: 'Unrelated', tokens: tokensOf('Cut production build time roughly 60% by migrating the project from Webpack to Vite'), titleTokens: new Set(), isFrame: false, ...classifyBead({ description: 'x', labels: [] }) },
  ];
  const hit = match(tokensOf('Contributed 4 merged PRs spanning editor features, docs infrastructure and visual regression testing — plus an ongoing animated example generator for command documentation, and a 65-case visual regression suite for the docs site.'), corpus, { minContainment: 0.45, minShared: 4 });
  check('matches the right bead', hit.map((x) => x.id), ['rb-a']);
  const miss = match(tokensOf('Something entirely unrelated about payroll compliance'), corpus, { minContainment: 0.45, minShared: 4 });
  check('unrelated text matches nothing', miss.length, 0);

  if (failures === 0) {
    console.log(`✅ resume-beads self-test passed (${assertions} assertions)`);
    return 0;
  }
  console.error(`\n${failures} of ${assertions} self-test assertion(s) failed`);
  return 1;
}

function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args.includes('--self-test')) return runSelfTest();

  let asJson = false;
  let summary = false;
  let strict = false;
  let minContainment;
  let sidecarPath = null;
  let stores = DEFAULT_STORES;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') asJson = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--strict') strict = true;
    else if (arg.startsWith('--min-containment=')) minContainment = Number(arg.split('=')[1]);
    else if (arg === '--min-containment') minContainment = Number(args[++i]);
    else if (arg.startsWith('--sidecar=')) sidecarPath = arg.split('=')[1];
    else if (arg.startsWith('--stores=')) stores = arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('-')) {
      console.error(`ERROR: unknown flag: ${arg}`);
      return 1;
    } else positional.push(arg);
  }

  if (positional.length !== 1) {
    console.error('Usage: node resume-beads.mjs <payload.json> [--summary|--json] [--strict]');
    console.error('       node resume-beads.mjs <payload.json> [--min-containment=0.55] [--stores=a,b]');
    console.error('       node resume-beads.mjs --self-test');
    return 1;
  }

  const targetPath = resolve(positional[0]);
  if (!existsSync(targetPath)) {
    console.error(`ERROR: payload not found: ${targetPath}`);
    return 1;
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(targetPath, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: payload is not valid JSON: ${err.message}`);
    return 1;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    console.error('ERROR: payload must be a JSON object');
    return 1;
  }

  let corpus;
  let storeFailures = [];
  try {
    const loaded = loadCorpus(stores);
    corpus = loaded.corpus;
    storeFailures = loaded.failures;
  } catch (err) {
    console.error(`ERROR: could not read the bead stores: ${err.message}`);
    return 1;
  }
  if (corpus.length === 0) {
    console.error(`ERROR: no beads read from any of: ${stores.join(', ')} — nothing to match against.`);
    return 1;
  }

  let sidecar = null;
  if (sidecarPath) {
    try {
      const side = JSON.parse(readFileSync(resolve(sidecarPath), 'utf-8'));
      sidecar = new Map(Object.entries(side.beads || {}).map(([t, ref]) => [normalizeText(t), ref]));
    } catch (err) {
      console.error(`ERROR: cannot read sidecar ${sidecarPath}: ${err.message}`);
      return 1;
    }
  }

  const result = mapPayload(payload, corpus, { minContainment, sidecar });

  if (asJson) console.log(JSON.stringify({ file: basename(targetPath), stores, ...result }, null, 2));
  else if (summary) printSummary(basename(targetPath), result);
  else printReport(basename(targetPath), result, storeFailures);

  if (strict && (result.tally[UNCONFIRMED] > 0 || result.tally[STALE] > 0
    // Summary/skills prose is not bead-linked yet, so only bullets must resolve.
    || (sidecar && result.rows.some((r) => r.kind !== 'prose' && r.beads.length === 0)))) return 1;
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli();
}
