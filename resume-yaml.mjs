#!/usr/bin/env node

/**
 * resume-yaml.mjs — batch-edit the résumé as one YAML file, then fold it back into the beads.
 *
 *   bun resume-yaml.mjs export <payload.json> --resume=<id> [--out=file.yml]
 *   bun resume-yaml.mjs apply  <file.yml> <payload.json> --resume=<id> [--write]
 *
 * export  writes the résumé the way the page renders it NOW (jobs and bullets in
 *         render order, text from the beads) to YAML. Default out: output/<resume-id>.edit.yml
 * apply   diffs the YAML against the beads and prints what would change. Nothing is
 *         written without --write. With --write:
 *           - summary text           -> the summary bead
 *           - job role / company     -> the job (frame) bead's position: / company: / location: (descriptor) lines
 *           - bullet text            -> that bullet bead's description (un-confirms it)
 *           - bullet without `bead:` -> a new draft resume_bullets bead, added to the job
 *           - bullet order / removal -> the job bead's metadata.bullets (a removed bullet's
 *                                       bead stays; it is only unlisted)
 *           - job order              -> the résumé manifest's workExperience order
 *         Skills, education, awards and dates are not in the file; edit those on their beads.
 *
 * Exit: 0 ok · 2 usage · 3 invalid YAML / unknown bead.
 */

import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { frameBulletIds, sidecarPath, summaryTextOf } from './payload-beads.mjs';
import { resolveLive } from './lavish-live.mjs';
import { checkBead } from './bead-typecheck.mjs';
import { typecheckResume } from './bead-tree.mjs';

const norm = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const run = (store, args) => execFileSync(store, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const HEADER = `# Résumé, in render order. Edit freely, then: bun resume-yaml.mjs apply <this file> <payload> --resume=<id> --write
# bead:  the bead that owns the text. Leave it out on a new bullet and one is created (draft).
# Reorder bullets or jobs by moving them. Delete a bullet to unlist it (its bead is kept).
# status: CONFIRMED / UNCONFIRMED / STALE (read-only, ignored on apply). Editing a bullet's text un-confirms it.
# Not here (edit on their beads): dates, skills, education, awards.
`;

export function exportYaml(payloadPath, resumeId) {
  const { payload, side, idx, resumeBead } = resolveLive(payloadPath, resumeId);
  const stat = (id) => (id && idx.get(id) ? idx.get(id).status : 'NEW');
  const doc = {
    summary: { bead: side.bindings.summary?.bead ?? null, status: stat(side.bindings.summary?.bead), text: norm(payload.summary) },
    experience: (payload.experience || []).map((e, i) => ({
      bead: side.bindings[`experience[${i}]#frame`]?.bead ?? null,
      status: stat(side.bindings[`experience[${i}]#frame`]?.bead),
      role: e.role ?? '',
      company: e.company ?? '',
      descriptor: e.location ?? '',
      bullets: (e.bullets || []).map((text, j) => ({ bead: side.bindings[`experience[${i}].bullets[${j}]`]?.bead ?? null, status: stat(side.bindings[`experience[${i}].bullets[${j}]`]?.bead), text: norm(text) })),
    })),
  };
  // Spacing for the human: a blank line between bullets, two between jobs.
  const { experience, summary } = doc;
  const dump = (o) => yaml.dump(o, { lineWidth: -1, noRefs: true });
  const exp = dump({ experience })
    .replace(/^(  - bead: )/gm, '\n\n$1')
    .replace(/^(      - bead: )/gm, '\n$1')
    .replace(/^(experience:)\n+/m, '$1\n')
    .replace(/^(    bullets:)\n+/gm, '$1\n');
  const comment = (lines) => lines.map((l) => `# ${l}`.trimEnd()).join('\n');
  const manifest = JSON.parse(resumeBead?.description || '{}');
  const eduLines = (manifest.sections?.education || []).flatMap((e) => String(idx.get(e.bead)?.bead.description ?? '').split('\n').map((l) => l.trimEnd()));
  const skillLines = (payload.skills || []).map((k) => `${k.category}: ${[].concat(k.items ?? []).join(', ')}`);
  const bar = (name) => `## -- ${name}`;
  return [
    HEADER.trimEnd(), '', bar('CAREER'), dump({ summary }).trimEnd(), '', '',
    bar('WORK EXPERIENCE'), exp.trimEnd(), '', '',
    bar('EDUCATION (read-only here; edit on its bead)'), comment(eduLines), '', '',
    bar('SKILLS (read-only here; edit on its bead)'), comment(skillLines), '',
  ].join('\n');
}

/** Pure: the YAML text + current state -> list of actions. */
export function planChanges(yamlText, { payload, side, idx, resumeBead }) {
  let doc;
  try { doc = yaml.load(yamlText); } catch (e) { return { error: `YAML does not parse: ${e.message}` }; }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.experience)) return { error: 'expected a mapping with an "experience:" list' };
  const actions = [];
  const errors = [];
  const seen = new Map();
  const note = (id, where) => { if (!id) return; if (seen.has(id)) errors.push(`bead ${id} listed twice (${seen.get(id)} and ${where})`); else seen.set(id, where); };

  const sum = doc.summary;
  if (sum?.bead) {
    const hit = idx.get(sum.bead);
    if (!hit) errors.push(`summary bead ${sum.bead} not found`);
    else if (norm(sum.text) !== norm(summaryTextOf(hit.bead.description) ?? hit.bead.description)) actions.push({ kind: 'summary', bead: sum.bead, text: norm(sum.text) });
  }

  doc.experience.forEach((job, i) => {
    const where = `experience[${i}]`;
    const frame = idx.get(job.bead);
    if (!frame) { errors.push(`${where}: job bead ${job.bead} not found`); return; }
    note(job.bead, where);
    const ex = payload.experience.find((_, k) => side.bindings[`experience[${k}]#frame`]?.bead === job.bead);
    if (ex && job.role && norm(job.role) !== norm(ex.role)) actions.push({ kind: 'frame-field', bead: job.bead, key: 'position', value: String(job.role).trim() });
    if (ex && job.company && norm(job.company) !== norm(ex.company)) actions.push({ kind: 'frame-field', bead: job.bead, key: 'company', value: String(job.company).trim() });
    if (ex && job.descriptor && norm(job.descriptor) !== norm(ex.location)) actions.push({ kind: 'frame-field', bead: job.bead, key: 'location', value: String(job.descriptor).trim() });
    const ids = [];
    (job.bullets || []).forEach((b, j) => {
      const w = `${where}.bullets[${j}]`;
      const text = norm(b?.text);
      if (!text) { errors.push(`${w}: empty text`); return; }
      if (b.bead) {
        const hit = idx.get(b.bead);
        if (!hit) { errors.push(`${w}: bead ${b.bead} not found`); return; }
        note(b.bead, w);
        ids.push(b.bead);
        if (norm(hit.bead.description) !== text) actions.push({ kind: 'bullet-text', bead: b.bead, text, store: hit.store });
      } else {
        ids.push(`new:${actions.filter((a) => a.kind === 'bullet-new').length}`);
        actions.push({ kind: 'bullet-new', job: job.bead, text });
      }
    });
    const current = frameBulletIds(frame.bead) || [];
    if (JSON.stringify(ids) !== JSON.stringify(current)) actions.push({ kind: 'job-bullets', job: job.bead, store: frame.store, ids });
  });

  for (const a of actions.filter((x) => x.kind === 'bullet-text' || x.kind === 'bullet-new')) {
    const probs = checkBead('bullet', { description: a.text });
    if (probs.length) errors.push(`"${a.text.slice(0, 50)}…": ${probs.join('; ')}`);
  }

  const order = doc.experience.map((j) => j.bead);
  const manifest = JSON.parse(resumeBead?.description || '{}');
  const cur = (manifest.sections?.workExperience || []).map((e) => e.bead);
  const wanted = order.filter((id) => cur.includes(id));
  if (wanted.length && JSON.stringify(wanted) !== JSON.stringify(cur.filter((id) => wanted.includes(id)))) actions.push({ kind: 'job-order', order: wanted });
  return { actions, errors };
}

function describe(a, idx) {
  const t = (s) => `"${s.length > 70 ? `${s.slice(0, 70)}…` : s}"`;
  switch (a.kind) {
    case 'summary': return `summary ${a.bead}: ${t(a.text)}`;
    case 'frame-field': return `${a.bead} ${a.key}: ${t(a.value)}`;
    case 'bullet-text': return `${a.bead} text -> ${t(a.text)}`;
    case 'bullet-new': return `NEW bullet under ${a.job}: ${t(a.text)}`;
    case 'job-bullets': return `${a.job} bullet order/list -> ${a.ids.join(', ')}`;
    case 'job-order': return `job order -> ${a.order.join(', ')}`;
    default: return JSON.stringify(a);
  }
}

function applyAll(actions, { idx, resumeBead, resumeId }) {
  const created = [];
  for (const a of actions.filter((x) => x.kind === 'bullet-new')) {
    const sib = [...idx.values()].find((v) => (frameBulletIds(idx.get(a.job)?.bead) || []).includes(v.bead.id) && v.store === 'resume_bullets');
    const labels = [...new Set([...(sib?.bead.labels || []).filter((l) => !/^confirmed:|^does-not-pass/.test(l)), 'resume-bullet', 'draft', 'sys:resume'])];
    const id = run('resume_bullets', ['create', a.text.slice(0, 60), '-d', a.text, '-l', labels.join(','), '--silent']).split('\n').pop();
    created.push(id);
    a.created = id;
  }
  let n = 0;
  for (const a of actions) {
    if (a.kind === 'bullet-text') run(a.store, ['update', a.bead, '-d', a.text]);
    else if (a.kind === 'summary') {
      const hit = idx.get(a.bead);
      const d = String(hit.bead.description || '');
      if (/^\s*careerSummary:/.test(d)) {
        const doc = yaml.load(d);
        const item = doc.careerSummary.find((i) => /^experience$/i.test(String(i?.title ?? '').trim()));
        item.text = a.text;
        run(hit.store, ['update', a.bead, '-d', yaml.dump(doc, { lineWidth: -1 })]);
      } else run(hit.store, ['update', a.bead, '-d', a.text]);
    } else if (a.kind === 'frame-field') {
      const hit = idx.get(a.bead);
      const re = new RegExp(`^(\\s*[•*-]?\\s*${a.key}:\\s*).+$`, 'm');
      if (!re.test(hit.bead.description)) throw new Error(`${a.bead} has no "${a.key}:" line to edit`);
      const next = hit.bead.description.replace(re, (_, p) => `${p}${a.value}`);
      run(hit.store, ['update', a.bead, '-d', next]);
      hit.bead.description = next; // several fields can change on one frame; each write must build on the last
    } else if (a.kind === 'job-bullets') {
      let k = 0;
      const ids = a.ids.map((id) => (id.startsWith('new:') ? actions.filter((x) => x.kind === 'bullet-new')[Number(id.slice(4))].created : id));
      run(a.store, ['update', a.job, '--set-metadata', `bullets=${JSON.stringify(ids)}`]);
      k += 1;
    } else if (a.kind === 'job-order') {
      const m = JSON.parse(resumeBead.description);
      const list = m.sections.workExperience;
      const rank = (e) => { const r = a.order.indexOf(e.bead); return r < 0 ? 1e6 : r; };
      m.sections.workExperience = [...list].sort((x, y) => rank(x) - rank(y));
      run('resumes', ['update', resumeId, '-d', JSON.stringify(m, null, 2)]);
    } else continue;
    n += 1;
  }
  return { applied: n, created };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const pos = args.filter((a) => !a.startsWith('--'));
  const [cmd] = pos;
  const resumeId = flag('resume');
  if (cmd === 'export' && pos[1] && resumeId) {
    const out = flag('out') || join('output', `${resumeId}.edit.yml`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, exportYaml(pos[1], resumeId));
    console.log(`wrote ${out}`);
  } else if (cmd === 'sync-payload' && pos[1] && resumeId) {
    const { payload, side } = resolveLive(pos[1], resumeId);
    const sp = sidecarPath(pos[1]);
    copyFileSync(pos[1], `${pos[1]}.bak`);
    copyFileSync(sp, `${sp}.bak`);
    writeFileSync(pos[1], `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(sp, `${JSON.stringify({ version: 1, bindings: side.bindings }, null, 2)}\n`);
    console.log(`rewrote ${pos[1]} and ${sp} from the beads (previous copies: .bak)`);
    const tc = typecheckResume(resumeId, pos[1]);
    console.log(`type check: ${tc.failures.length} failing bead(s) labelled on the beads`);
  } else if (cmd === 'apply' && pos[1] && pos[2] && resumeId) {
    const live = resolveLive(pos[2], resumeId);
    const { actions, errors, error } = planChanges(readFileSync(pos[1], 'utf8'), live);
    if (error) { console.error(error); process.exit(3); }
    for (const e of errors) console.error(`✗ ${e}`);
    if (errors.length) process.exit(3);
    if (!actions.length) { console.log('no changes'); process.exit(0); }
    for (const a of actions) console.log(`${args.includes('--write') ? '•' : '→'} ${describe(a, live.idx)}`);
    if (!args.includes('--write')) { console.log(`\n${actions.length} change(s). Re-run with --write to apply.`); process.exit(0); }
    const r = applyAll(actions, { idx: live.idx, resumeBead: live.resumeBead, resumeId });
    console.log(`\napplied ${r.applied} change(s)${r.created.length ? `; created ${r.created.join(', ')}` : ''}. Edited beads are unconfirmed.`);
    const tc = typecheckResume(resumeId, pos[2]);
    console.log(`type check: ${tc.failures.length} failing bead(s) labelled on the beads`);
  } else {
    console.error('usage: bun resume-yaml.mjs export <payload.json> --resume=<id> [--out=f]\n       bun resume-yaml.mjs apply <f.yml> <payload.json> --resume=<id> [--write]');
    process.exit(2);
  }
}
