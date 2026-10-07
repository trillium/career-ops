#!/usr/bin/env node

/**
 * cv-duplicate-check.mjs — detect the same statement asserted twice on one CV.
 *
 * A third class of CV bug, alongside the two existing gates:
 *   verify-cv-facts.mjs     blocks FABRICATION  (a claim absent from the source)
 *   verify-cv-structure.mjs warns about LOSS    (structure dropped vs cv.md)
 *   this file               warns about REDUNDANCY (a claim asserted twice)
 *
 * Redundancy is invisible to both existing gates. Every statement is true, every
 * source fact is present, the structure is faithful — and the same achievement
 * still occupies two sections. On a one-page CV that is the worst kind of bug:
 * it costs a line, and it reads to a reviewer as padding, because a reader who
 * notices the repeat learns nothing new the second time.
 *
 * Written 2026-10-07 after the PostHog Product Engineer CV (report 011) shipped
 * with two Hack for LA claims stated twice:
 *
 *   awards[0]            "Mentored 25+ contributors through code review to
 *                         production merges — Hack for LA, 2022 – 2026"
 *   experience[3].bullets[3]  "Mentored 25+ contributors to merged production
 *                         code in an async, distributed team of 15+, reviewing
 *                         their work and keeping codebase context alive..."
 *
 * The second is a rewording of the first — no shared 4-token run, and token
 * similarity only 0.23, so a plain fuzzy-match check misses it. What gives it
 * away is the shared QUANTIFIED CLAIM: "25+ contributors". That is why this
 * checker treats a repeated number+head-noun pair as a first-class signal
 * rather than a tie-breaker.
 *
 * Non-blocking by design, for the same reason verify-cv-structure.mjs is: some
 * repetition is legitimate. A summary deliberately restates a headline
 * achievement, and a skills category may name a technology that a bullet also
 * names. This reports pairs for a human to judge; --strict turns only the
 * high-confidence near-duplicates into a failure.
 *
 * Usage:
 *   node cv-duplicate-check.mjs <payload.json>
 *   node cv-duplicate-check.mjs <cv.md>
 *   node cv-duplicate-check.mjs <payload.json> --min-overlap=0.55 --json
 *   node cv-duplicate-check.mjs <payload.json> --summary --strict
 *   node cv-duplicate-check.mjs --self-test
 *
 * Exit: 0 normally (a warning, not a gate). 1 only with --strict and a
 * high-confidence near-duplicate. UNVERIFIED (exit 0) when the input yields
 * fewer than two comparable statements — nothing was checked, and saying
 * "passed" would be a false clean.
 */

import { existsSync, readFileSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';

/**
 * Words that carry no topical signal. Removing them before comparison keeps a
 * pair of unrelated bullets from looking similar merely because both are
 * written in English prose. Deliberately conservative: anything that could
 * distinguish one claim from another stays in.
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'across', 'after', 'again', 'all', 'also', 'an',
  'and', 'another', 'any', 'are', 'as', 'at', 'be', 'because', 'been',
  'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'every',
  'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her',
  'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'of', 'off',
  'on', 'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'per',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'us', 'very', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
  'with', 'within', 'would', 'you', 'your',
]);

/**
 * Low-information tokens: words that appear in nearly every CV line and so
 * cannot distinguish a copied claim from a shared noun phrase.
 *
 * Used ONLY to judge whether a shared token run is distinctive. It must not be
 * used to filter quantified claims: '25+ contributors' and '5 tenants' are
 * exactly the claims worth comparing, and dropping them here is what made the
 * first draft of this checker miss its own originating bug.
 */
const LOW_INFO = new Set([
  'built', 'build', 'building', 'create', 'created', 'create', 'develop',
  'developed', 'worked', 'working', 'work', 'team', 'teams', 'code',
  'codebase', 'project', 'projects', 'platform', 'platforms', 'system',
  'systems', 'tool', 'tools', 'tooling', 'user', 'users', 'customer',
  'customers', 'developer', 'developers', 'contributor', 'contributors',
  'open', 'source', 'remote', 'present', 'experience', 'engineering',
  'engineer', 'software', 'product', 'production', 'using', 'used', 'use',
  'new', 'plus', 'including', 'include', 'includes', 'spanning', 'serving',
  'covering', 'ending', 'existing', 'multiple', 'various', 'several', 'key',
  'major', 'full', 'entire', 'ongoing', 'current', 'related', 'including',
  'feature', 'features', 'service', 'services', 'company', 'companies',
  'developer', 'building', 'across', 'end', 'own', 'owning', 'led', 'leading',
  'supported', 'supporting', 'support', 'helping', 'helped', 'maintaining',
  'maintained', 'delivering', 'delivered', 'providing', 'provided',
]);

/**
 * A shared run this long is a copied phrase, whatever it contains.
 */
const RUN_LONG = 5;

/**
 * How much of the SHORTER statement must be shared before the pair counts as
 * one statement restated.
 *
 * This is the rule that catches the originating bug, and it is worth knowing
 * why. Token similarity alone misses it: 'Mentored 25+ contributors through
 * code review to production merges' scores only 0.23 against its reworded twin,
 * because the twin hangs ~11 extra words of qualifier off the same claim. What
 * they share is 71% of the SHORTER statement — the claim itself.
 *
 * A shared FIGURE is deliberately not sufficient on its own: two different
 * products that each serve '2,000+ users' share 18% of the shorter statement
 * and are not the same claim. A repeated figure flags a REVIEW, not a
 * duplicate.
 */
const CONT_FLOOR = 0.45;

/**
 * A skills/competencies unit is a list, not a statement. A skills row naming a
 * technology that a bullet also names is what a skills section is FOR, so
 * list-vs-prose pairs are never compared.
 */
const LIST_SECTION = /skill|competenc|technolog/i;

function isListUnit(unit) {
  return unit.kind === 'list' || LIST_SECTION.test(unit.section);
}

function normalizeText(input) {
  return String(input)
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u00A0/g, ' ')
    // Digit-group commas belong to the number: stripping them after the
    // punctuation sweep below would split "2,000+ users" into "2  000+" and
    // lengthen any shared run across it, which read as a copied phrase.
    .replace(/(\d),(?=\d)/g, '$1')
    .toLowerCase()
    // Keep + % # and intra-token . / - (25+, 96%, 1-to-n, next.js, 65-case),
    // drop everything else so punctuation never separates identical claims.
    .replace(/[^a-z0-9+#%./\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ordered substance tokens, punctuation trimmed off each token's edges. */
function tokenize(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  return norm
    .split(' ')
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((t) => t.length > 0 && !/^[./-]+$/.test(t));
}

function substanceTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

function isNumberish(token) {
  return /^\d/.test(token);
}

/** 19xx/20xx years are on every entry and would flag every pair. */
function isYear(token) {
  return /^(19|20)\d{2}$/.test(token);
}

function nounStem(noun) {
  return noun.length > 4 && noun.endsWith('s') ? noun.slice(0, -1) : noun;
}

/**
 * Quantified claims as `number|noun` keys — the strongest duplicate signal,
 * because it survives any amount of rewording around it.
 *
 * "Mentored 25+ contributors through code review" and "Mentored 25+
 * contributors to merged production code" share `25+|contributor`.
 */
function quantifiedClaims(text) {
  const out = new Set();
  const re = /\b(\d[\d,]*(?:\.\d+)?)\s*(\+?)\s+([a-z][a-z-]{2,})/gi;
  let m;
  while ((m = re.exec(normalizeText(text))) !== null) {
    const num = m[1].replace(/,/g, '');
    if (isYear(num) && !m[2]) continue;
    if (STOPWORDS.has(m[3])) continue;
    out.add(`${num}${m[2]}|${nounStem(m[3])}`);
  }
  return out;
}

/**
 * Proper nouns, detected by ORIGINAL capitalisation at a non-initial position.
 * "Cursorless", "Talon", "Hack for LA", "VRMS", "Supabase". Used to notice two
 * statements talking about the same named subject with different figures.
 */
function properNouns(text) {
  const out = new Set();
  const raw = String(text).replace(/[\u2018\u2019]/g, "'").split(/\s+/);
  for (let i = 1; i < raw.length; i++) {
    const word = raw[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (word.length < 3) continue;
    if (!/^[A-Z][a-z0-9]/.test(word)) continue;
    // Sentence-initial words are capitalised by grammar, not by being a name.
    if (/[.!?:]$/.test(raw[i - 1])) continue;
    out.add(word.toLowerCase());
  }
  return out;
}

function numericTokens(text) {
  return tokenize(text).filter((t) => isNumberish(t) && !isYear(t.replace(/[+,]/g, '')));
}

/**
 * Longest run of consecutively-matching substance tokens between two units.
 * Returns the run itself, not just its length, because whether a shared run
 * means "copied phrase" depends on WHAT is in it.
 */
function longestSharedRun(tokensA, tokensB) {
  const setB = new Set(tokensB);
  let best = [];
  let run = [];
  for (const token of tokensA) {
    if (setB.has(token)) {
      run.push(token);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
  }
  return best;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function containment(setA, setB) {
  const small = Math.min(setA.size, setB.size);
  if (small === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  return shared / small;
}

function intersect(setA, setB) {
  const out = [];
  for (const t of setA) if (setB.has(t)) out.push(t);
  return out;
}

// ── Unit extraction ─────────────────────────────────────────────────────────

/**
 * A "unit" is one comparable statement: a bullet, an award line, a summary.
 * `ref` is what the user can act on — the exact payload path to edit.
 */
function makeUnit(ref, section, text, kind) {
  const trimmed = String(text).replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const tokens = substanceTokens(trimmed);
  return {
    ref,
    section,
    kind,
    text: trimmed,
    tokens,
    tokenSet: new Set(tokens),
    claims: quantifiedClaims(trimmed),
    props: properNouns(trimmed),
    numbers: new Set(numericTokens(trimmed)),
  };
}

export function extractFromPayload(payload) {
  const units = [];
  const add = (u) => { if (u) units.push(u); };

  add(makeUnit('summary', 'summary', payload.summary, 'prose'));

  if (Array.isArray(payload.skills)) {
    payload.skills.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const items = Array.isArray(s.items) ? s.items.join(', ') : '';
      add(makeUnit(`skills[${i}]`, 'skills', [s.category, items].filter(Boolean).join(': '), 'list'));
    });
  }

  if (Array.isArray(payload.experience)) {
    payload.experience.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const label = e.company || e.role || `entry ${i}`;
      if (Array.isArray(e.bullets)) {
        e.bullets.forEach((b, j) => {
          add(makeUnit(`experience[${i}].bullets[${j}]`, `experience:${label}`, b, 'bullet'));
        });
      }
    });
  }

  for (const section of ['projects', 'awards', 'certifications', 'education']) {
    if (!Array.isArray(payload[section])) continue;
    payload[section].forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const text = [entry.title, entry.org, entry.year].filter(Boolean).join(' - ');
      add(makeUnit(`${section}[${i}]`, section, text, section === 'education' ? 'education' : 'award'));
    });
  }

  return units;
}

/**
 * Markdown metadata is not a statement. cv.md carries italic role/date lines
 * (`*Open source · 2024 – Present*`), a contact header, and section labels;
 * comparing those against each other produced 13 "duplicates" on a real cv.md,
 * of which exactly one was real. A checker that cries wolf on every date line
 * gets turned off, so these are dropped before comparison.
 */
function looksLikeMarkdownMetadata(line) {
  if (/[\w.+-]+@[\w-]+\.\w+/.test(line)) return true;
  // Fully italic / bolded lines are role and date metadata, not claims.
  if (/^[*_]{1,2}[^*_].*[*_]{1,2}$/.test(line) && !/^[*-]\s/.test(line)) return true;
  return false;
}

/**
 * Markdown CVs: a heading opens a section, `-`/`*` lines are bullets, and
 * non-blank prose lines are paragraph units. Indented or unmarked continuation
 * lines fold into the unit above them, because cv.md wraps.
 */
export function extractFromMarkdown(markdown) {
  const units = [];
  let section = '(untitled)';
  let headingCounters = new Map();
  let pending = null;

  const flush = () => {
    if (!pending) return;
    const u = makeUnit(pending.ref, pending.section, pending.text, pending.kind);
    // Keep the original 1-based line so the user can jump straight to it.
    if (u) units.push({ ...u, line: pending.line });
    pending = null;
  };

  markdown.split('\n').forEach((rawLine, idx) => {
    const line = rawLine.trim();
    const lineNo = idx + 1;
    if (!line) { flush(); return; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      section = heading[2].trim();
      return;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flush();
      const n = (headingCounters.get(section) || 0) + 1;
      headingCounters.set(section, n);
      pending = {
        ref: `${section} bullet ${n}`,
        section,
        text: bullet[1],
        kind: 'bullet',
        line: lineNo,
      };
      return;
    }

    // Contact header, italic role/date lines: metadata, not a statement.
    if (looksLikeMarkdownMetadata(line)) {
      flush();
      return;
    }

    // Continuation of the unit above (indented wrap), else a standalone prose
    // line (e.g. the italic `*Open source · 2024 – Present*` meta lines).
    if (pending && /^\s{2,}\S/.test(rawLine)) {
      pending.text += ` ${line}`;
      return;
    }
    flush();
    const n = (headingCounters.get(section) || 0) + 1;
    headingCounters.set(section, n);
    pending = {
      ref: `${section} line ${lineNo}`,
      section,
      text: line.replace(/^\*+|\*+$/g, ''),
      kind: 'prose',
      line: lineNo,
    };
  });
  flush();

  return units;
}

// ── Comparison ──────────────────────────────────────────────────────────────

export const DEFAULT_MIN_OVERLAP = 0.55;

/**
 * Compare every pair of units. Returns findings worst-first:
 *   duplicate — high-confidence restatement (near-identical, or a copied run)
 *   overlap   — the same figure or named subject appears twice, reworded
 */
export function findDuplicates(units, { minOverlap = DEFAULT_MIN_OVERLAP } = {}) {
  const findings = [];

  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      if (a.tokenSet.size === 0 || b.tokenSet.size === 0) continue;

      // A summary is expected to preview a claim made below it; report it as a
      // softer overlap so the summary does not drown the real signal.
      const summaryPair = a.section === 'summary' || b.section === 'summary';

      // A skills category naming a technology that a bullet also names is not a
      // duplicated statement — that is exactly what a skills section is for.
      // Only list-vs-list and prose-vs-prose are comparable.
      if (isListUnit(a) !== isListUnit(b)) continue;

      const shared = intersect(a.tokenSet, b.tokenSet);
      const distinctive = shared.filter((t) => t.length >= 4 || isNumberish(t));
      const jac = jaccard(a.tokenSet, b.tokenSet);
      const cont = containment(a.tokenSet, b.tokenSet);
      const claims = intersect(a.claims, b.claims);
      const props = intersect(a.props, b.props);
      const numbersDiffer =
        a.numbers.size > 0 && b.numbers.size > 0 &&
        !(a.numbers.size === b.numbers.size && [...a.numbers].every((n) => b.numbers.has(n)));

      const runTokens = longestSharedRun(a.tokens, b.tokens);
      const run = runTokens.length;
      // Three independent ways a pair is one statement asserted twice:
      //   1. a long identical run — a copied phrase
      //   2. most of the SHORTER statement contained in the longer — a short
      //      claim re-asserted with extra qualifiers hung off it
      //   3. near-identical overall token similarity
      const longRun = run >= RUN_LONG;
      const contained =
        cont >= CONT_FLOOR && distinctive.length >= 2 && Math.min(a.tokenSet.size, b.tokenSet.size) >= 4;
      const nearIdentical = jac >= minOverlap && distinctive.length >= 2;

      // Two entries in the SAME section naming one subject with different
      // figures is normal (one employer, two projects). Across sections it is a
      // signal: 'Cursorless' with 10 PRs in one entry and 4 in another.
      const sameSection = a.section === b.section;
      const crossSubject = !sameSection && props.length > 0 && numbersDiffer;
      const hard = longRun || contained || nearIdentical;
      const soft = claims.length > 0 || crossSubject;
      if (!hard && !soft) continue;

      const reasons = [];
      if (longRun) reasons.push(`${run}-token identical run`);
      if (contained) reasons.push(`${(cont * 100).toFixed(0)}% of the shorter statement is contained in the longer`);
      if (nearIdentical) reasons.push(`${jac.toFixed(2)} token similarity`);
      if (claims.length > 0) reasons.push(`the same figure appears in both: ${claims.join(', ')}`);
      if (claims.length === 0 && crossSubject) {
        reasons.push(`the same subject appears with different figures: ${props.join(', ')}`);
      }

      // A summary is expected to preview a claim made below it, so it can only
      // ever be an overlap — never the hard duplicate that --strict fails on.
      const verdict = hard && !summaryPair ? 'duplicate' : 'overlap';

      findings.push({
        verdict,
        a: { ref: a.ref, section: a.section, text: a.text, line: a.line },
        b: { ref: b.ref, section: b.section, text: b.text, line: b.line },
        similarity: Number(jac.toFixed(3)),
        containment: Number(cont.toFixed(3)),
        longestRun: run,
        sharedClaims: claims,
        sharedSubjects: props,
        reasons,
      });
    }
  }

  const rank = { duplicate: 0, overlap: 1 };
  findings.sort((x, y) => {
    if (rank[x.verdict] !== rank[y.verdict]) return rank[x.verdict] - rank[y.verdict];
    if (y.longestRun !== x.longestRun) return y.longestRun - x.longestRun;
    return y.similarity - x.similarity;
  });
  return findings;
}

export function checkDocument(units, options = {}) {
  const comparable = units.filter((u) => u.tokenSet.size >= 2);
  if (comparable.length < 2) {
    return { status: 'unverified', units: units.length, comparable: comparable.length, findings: [] };
  }
  return {
    status: 'checked',
    units: units.length,
    comparable: comparable.length,
    findings: findDuplicates(comparable, options),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function readUnits(filePath) {
  const ext = extname(filePath).toLowerCase();
  const raw = readFileSync(filePath, 'utf-8');
  if (ext === '.json') {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return { error: `not valid JSON: ${err.message}` };
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { error: `payload must be a JSON object, got ${payload === null ? 'null' : Array.isArray(payload) ? 'an array' : typeof payload}` };
    }
    return { units: extractFromPayload(payload) };
  }
  if (ext === '.md' || ext === '.markdown') {
    return { units: extractFromMarkdown(raw) };
  }
  return { error: `unsupported extension ${ext || '(none)'} — expected .json (tailored CV payload) or .md (cv.md)` };
}

function truncate(text, max = 88) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function printReport(targetPath, result, findings) {
  const name = basename(targetPath);
  if (result.status === 'unverified') {
    console.warn(`⚠️  CV duplicate check UNVERIFIED: ${name}`);
    console.warn(`Found only ${result.comparable} comparable statement(s) in ${result.units} extracted unit(s) — nothing was checked.`);
    console.warn('Expected a tailored-CV payload with experience bullets/awards, or a markdown CV with headings and bullets.');
    return;
  }

  const duplicates = findings.filter((f) => f.verdict === 'duplicate');
  const overlaps = findings.filter((f) => f.verdict === 'overlap');

  if (findings.length === 0) {
    console.log(`✅ CV duplicate check passed: ${name} — ${result.comparable} statements compared, no repeats.`);
    return;
  }

  console.warn(`⚠️  CV duplicate check: ${name}`);
  console.warn(`${duplicates.length} duplicated statement(s) and ${overlaps.length} overlapping figure(s) across ${result.comparable} statements.`);

  const block = (title, list) => {
    if (list.length === 0) return;
    console.warn(`\n${title}`);
    for (const f of list) {
      console.warn(`  ${f.a.ref}  ↔  ${f.b.ref}`);
      console.warn(`    A: ${truncate(f.a.text)}`);
      console.warn(`    B: ${truncate(f.b.text)}`);
      console.warn(`    why: ${f.reasons.join('; ')}`);
    }
  };
  block('DUPLICATED STATEMENTS (high confidence — same claim stated twice)', duplicates);
  block('OVERLAPPING FIGURES (review: one may be a subset of the other)', overlaps);

  console.warn('\nThis is a warning, not a blocking gate — a summary previewing a headline claim is');
  console.warn('legitimate, and repetition in a skills category is not a duplicate statement.');
  console.warn('On a one-page CV, though, each repeated claim costs a line and reads as padding:');
  console.warn('keep the version with the most specific detail in the section that owns it, and');
  console.warn('drop the other. Re-run with --strict to make duplicates a non-zero exit.');
}

function printSummary(targetPath, result, findings) {
  const dup = findings.filter((f) => f.verdict === 'duplicate').length;
  const ovl = findings.filter((f) => f.verdict === 'overlap').length;
  if (result.status === 'unverified') {
    console.log(`${basename(targetPath)}\tUNVERIFIED\t-`);
    return;
  }
  console.log(`${basename(targetPath)}\t${findings.length === 0 ? 'clean' : 'findings'}\tduplicates=${dup}\toverlaps=${ovl}\tcompared=${result.comparable}`);
}

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const check = (label, actual, expected) => {
    assertions += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      failures += 1;
      console.error(`FAIL: ${label}`);
      console.error(`  expected: ${JSON.stringify(expected)}`);
      console.error(`  actual:   ${JSON.stringify(actual)}`);
    }
  };

  // The originating bug: same claim, different wording, low token similarity.
  const mentored = checkDocument([
    makeUnit('awards[0]', 'awards', 'Mentored 25+ contributors through code review to production merges', 'award'),
    makeUnit('experience[3].bullets[3]', 'experience:Hack for LA', 'Mentored 25+ contributors to merged production code in an async, distributed team of 15+, reviewing their work and keeping codebase context alive across contributor turnover', 'bullet'),
  ]);
  check('mentored reworded duplicate is caught', mentored.findings[0]?.verdict, 'duplicate');
  check('mentored duplicate cites the shared figure', mentored.findings[0]?.sharedClaims, ['25+|contributor']);

  // The second originating bug: verbatim copied phrase.
  const promoted = checkDocument([
    makeUnit('awards[1]', 'awards', 'Promoted from Software Developer to Lead within 8 months - Hack for LA - 2023', 'award'),
    makeUnit('experience[3].bullets[0]', 'experience:Hack for LA', 'Promoted from Software Developer to Lead within 8 months; own the Volunteer Requirement Management System (VRMS) end to end - an open-source civic platform serving 2,000+ users', 'bullet'),
  ]);
  check('promoted copied run is caught', promoted.findings[0]?.verdict, 'duplicate');
  check('promoted run length is 6', promoted.findings[0]?.longestRun, 6);

  // Genuinely different claims that share a coincidental figure.
  const coincidental = checkDocument([
    makeUnit('experience[0].bullets[5]', 'experience:TS Consulting', 'Resolved critical access issues for a coaching platform serving 2,000+ users - CSS scoping, coupon-system bugs and email delivery - within same-day turnaround', 'bullet'),
    makeUnit('experience[3].bullets[0]', 'experience:Hack for LA', 'Own the Volunteer Requirement Management System (VRMS) end to end - an open-source civic platform serving 2,000+ users', 'bullet'),
  ]);
  check('coincidental shared figure is not a duplicate', coincidental.findings.filter((f) => f.verdict === 'duplicate').length, 0);

  // Unrelated bullets must stay clean.
  const clean = checkDocument([
    makeUnit('experience[2].bullets[0]', 'experience:Voice', 'Built talon_mcp, an MCP server exposing live machine state so agents can build against Talons nonstandard Rust core', 'bullet'),
    makeUnit('experience[3].bullets[2]', 'experience:Hack for LA', 'Cut production build time roughly 60% by migrating the project from Webpack to Vite', 'bullet'),
  ]);
  check('unrelated bullets produce no findings', clean.findings.length, 0);

  // A summary previewing a claim is an overlap, never a hard duplicate.
  const summary = checkDocument([
    makeUnit('summary', 'summary', 'Product engineer who owns what ships: built a multi-tenant booking SaaS end to end - now live for five tenants', 'prose'),
    makeUnit('experience[0].bullets[0]', 'experience:TS Consulting', 'Built and shipped a white-label booking SaaS for 1:1 practitioners, now live for 5 tenants across three service industries', 'bullet'),
  ]);
  check('summary preview is not a hard duplicate', summary.findings.filter((f) => f.verdict === 'duplicate').length, 0);

  // Subset counts about one subject: 10 across Cursorless + community, then 4.
  const subset = checkDocument([
    makeUnit('experience[2].bullets[1]', 'experience:Voice', 'Shipped 10 merged upstream PRs across Cursorless and talonhub/community - voice-addressable hat colors', 'bullet'),
    makeUnit('experience[4].bullets[0]', 'experience:Cursorless', 'Contributed 4 merged PRs spanning editor features, docs infrastructure and visual regression testing to Cursorless', 'bullet'),
  ]);
  check('subset count on one subject is flagged for review', subset.findings.length, 1);
  check('subset finding is an overlap, not a duplicate', subset.findings[0]?.verdict, 'overlap');
  check('subset finding names the shared subject', subset.findings[0]?.sharedSubjects, ['cursorless']);

  // Markdown extraction and the UNVERIFIED path.
  const md = extractFromMarkdown([
    '## Experience',
    '',
    '### Hack for LA - Software Developer',
    '',
    '- Promoted from Software Developer to Lead within 8 months; owned the VRMS end to end.',
    '- Migrated the web build tooling from Webpack to Vite, cutting compilation time by 60%.',
    '',
    '## Leadership & Community',
    '',
    '- **Open-source mentorship:** Mentored 25+ volunteer developers over 4+ years at Hack for LA through pull request reviews.',
  ].join('\n'));
  check('markdown extractor finds the bullets', md.length, 3);
  check('markdown extractor records line numbers', typeof md[0].line, 'number');

  // Metadata lines must not become statements.
  const mdMeta = extractFromMarkdown([
    'Trillium Smith',
    'trillium@trilliumsmith.com · [trilliumsmith.com](https://www.trilliumsmith.com) · Los Angeles, CA',
    '',
    '### Talon Voice Ecosystem — Tooling Contributor',
    '*Open source · 2024 – Present*',
    '- Built a voice window-router and custom Talon scripts for hands-free coding.',
    '',
    '### Cursorless — Contributor',
    '*Open source · 2024 – Present*',
    '- Contributed upstream PRs to the visual regression suite.',
  ].join('\n'));
  check('markdown metadata lines are not statements', mdMeta.length, 3);
  check('markdown metadata produces no duplicates', checkDocument(mdMeta).findings.length, 0);

  const tooFew = checkDocument([makeUnit('a', 'x', 'one lone statement here', 'bullet')]);
  check('single statement reports UNVERIFIED', tooFew.status, 'unverified');

  if (failures === 0) {
    console.log(`✅ cv-duplicate-check self-test passed (${assertions} assertions)`);
    return 0;
  }
  console.error(`\n${failures} of ${assertions} self-test assertion(s) failed`);
  return 1;
}

function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args.includes('--self-test')) return runSelfTest();

  let minOverlap = DEFAULT_MIN_OVERLAP;
  let asJson = false;
  let summary = false;
  let strict = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') asJson = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--strict') strict = true;
    else if (arg === '--min-overlap') {
      if (!args[i + 1]) { console.error('ERROR: --min-overlap requires a number'); return 1; }
      minOverlap = Number(args[++i]);
    } else if (arg.startsWith('--min-overlap=')) {
      minOverlap = Number(arg.slice('--min-overlap='.length));
    } else if (arg.startsWith('-')) {
      console.error(`ERROR: unknown flag: ${arg}`);
      return 1;
    } else {
      positional.push(arg);
    }
  }

  if (!Number.isFinite(minOverlap) || minOverlap <= 0 || minOverlap > 1) {
    console.error(`ERROR: --min-overlap must be a number in (0, 1], got ${minOverlap}`);
    return 1;
  }

  if (positional.length === 0) {
    console.error('Usage: node cv-duplicate-check.mjs <payload.json|cv.md> [--min-overlap=0.55] [--json] [--summary] [--strict]');
    console.error('       node cv-duplicate-check.mjs --self-test');
    return 1;
  }
  if (positional.length > 1) {
    console.error(`ERROR: unexpected extra argument: ${positional[1]}`);
    return 1;
  }

  const targetPath = resolve(positional[0]);
  if (!existsSync(targetPath)) {
    console.error(`ERROR: input not found: ${targetPath}`);
    return 1;
  }

  const read = readUnits(targetPath);
  if (read.error) {
    console.error(`ERROR: ${read.error}: ${targetPath}`);
    return 1;
  }

  const result = checkDocument(read.units, { minOverlap });

  if (asJson) {
    console.log(JSON.stringify({ file: basename(targetPath), ...result }, null, 2));
  } else if (summary) {
    printSummary(targetPath, result, result.findings);
  } else {
    printReport(targetPath, result, result.findings);
  }

  const duplicates = result.findings.filter((f) => f.verdict === 'duplicate').length;
  if (strict && duplicates > 0) return 1;
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli();
}
