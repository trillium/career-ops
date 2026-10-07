#!/usr/bin/env node

/**
 * build-bead-resume.mjs — build a résumé from a bead-backed resume, showing
 * exactly which text is not yet human-confirmed.
 *
 * Unlike beads-to-cv.mjs this never refuses on an unconfirmed bead: it builds
 * anyway and makes the state impossible to miss.
 *
 *   - Every UNCONFIRMED or STALE item is rendered in RED.
 *   - If anything is red, the file name starts with DRAFT_ and the document
 *     carries a DRAFT banner and <title>. A fully confirmed résumé has neither.
 *   - Status is recomputed from each bead's CURRENT text (classifyBead), never
 *     trusted from a label's mere presence.
 *
 * Outputs, in output/resumes/:
 *   [DRAFT_]Name_Resume_<id>_<date>.html   self-contained
 *   [DRAFT_]Name_Resume_<id>_<date>.pdf    (skip with --no-pdf)
 *   [DRAFT_]Name_Resume_<id>_<date>.md     the single merged markdown, ✅/❌ marked
 *
 * Granularity: bullets use their own bead; summary and skills share the
 * careerSummary frame bead; each role/project heading uses its frame bead;
 * education uses its frame bead. The header (name/contacts) comes from
 * info.yml, not a bead, and is never coloured.
 *
 * Usage:   node build-bead-resume.mjs <resume-bead-id> [--no-pdf]
 * Env:     RESUME_PY (python with PyYAML), RESUME_PII_DIR
 * Exit:    0 built · 2 usage · 4 resolve failed
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyBead, readStore } from './resume-beads.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_PY = join(ROOT, 'local', 'resume-beads', 'resume-data.py');
const PY = process.env.RESUME_PY || join(homedir(), '.pyenv/shims/python3');
const STORES = ['resume_bullets', 'projects', 'employment', 'education', 'career'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** id -> status for every bead in the résumé stores. */
function statusIndex() {
  const idx = new Map();
  for (const store of STORES) {
    const r = readStore(store);
    if (!r.ok) throw new Error(`cannot read store ${store}: ${r.reason}`);
    for (const b of r.beads) idx.set(b.id, classifyBead(b).status);
  }
  return idx;
}

/** Collect every renderable item with its status, in document order. */
export function buildModel(data, idx) {
  const st = (id) => (id ? idx.get(id) ?? 'UNCONFIRMED' : 'UNCONFIRMED');
  const ok = (s) => s === 'CONFIRMED';
  const item = (text, id) => ({ text, id, status: st(id), ok: ok(st(id)) });
  const sections = [];

  if (data.summary) sections.push({ kind: 'prose', title: 'Summary', item: item(data.summary, data.frames?.summary) });
  if (data.skills) sections.push({ kind: 'prose', title: 'Technical Skills', item: item(data.skills, data.frames?.skills) });

  for (const [title, entries] of [['Experience', data.experience], ['Projects', data.projects]]) {
    if (!entries?.length) continue;
    sections.push({
      kind: 'entries',
      title,
      entries: entries.map((e) => ({
        head: item([e.title, e.org].filter(Boolean).join(' — '), e.frame),
        meta: e.meta || '',
        bullets: (e.bullets || []).map((b) => item(b, data.bead_map?.[b]?.id)),
      })),
    });
  }
  if (data.education?.length) {
    const fid = data.frames?.education?.[0];
    sections.push({ kind: 'list', title: 'Education', items: data.education.map((l) => item(l, fid)) });
  }

  const all = [];
  for (const s of sections) {
    if (s.item) all.push(s.item);
    for (const e of s.entries || []) all.push(e.head, ...e.bullets);
    all.push(...(s.items || []));
  }
  const unconfirmed = all.filter((i) => !i.ok);
  return { sections, total: all.length, unconfirmed: unconfirmed.length };
}

/** esc() then **bold** -> <strong>; beads store bold as markdown. */
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export function renderHtml(data, model, label) {
  const draft = model.unconfirmed > 0;
  const h = data.header || {};
  const cls = (i) => (i.ok ? '' : ' class="u"');
  const body = [];
  for (const s of model.sections) {
    body.push(`<h2>${esc(s.title)}</h2>`);
    if (s.kind === 'prose') body.push(`<p${cls(s.item)}>${inline(s.item.text)}</p>`);
    if (s.kind === 'entries') {
      for (const e of s.entries) {
        body.push(`<div class="head"><h3${cls(e.head)}>${inline(e.head.text)}</h3><span${cls(e.head)}>${esc(e.meta)}</span></div><ul>`);
        for (const b of e.bullets) body.push(`<li${cls(b)}>${inline(b.text)}</li>`);
        body.push('</ul>');
      }
    }
    if (s.kind === 'list') body.push('<ul>' + s.items.map((i) => `<li${cls(i)}>${inline(i.text)}</li>`).join('') + '</ul>');
  }
  const contacts = (h.contacts || []).map((c) => `<a href="${esc(c.url)}">${esc(c.label)}</a>`).join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${draft ? 'DRAFT ' : ''}${esc(h.name)} Resume ${esc(label)}</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  body { font: 10pt/1.35 Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0; } .sub { margin: 2px 0; } .contacts { font-size: 9pt; }
  a { color: inherit; text-decoration: none; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid #999; margin: 12px 0 4px; }
  h3 { font-size: 10.5pt; margin: 6px 0 0; } .head { display: flex; justify-content: space-between; }
  ul { margin: 2px 0 0; padding-left: 16px; } li { margin: 1px 0; } p { margin: 3px 0; }
  .u { color: #c00000; }
  .banner { border: 1.5px solid #c00000; color: #c00000; font-weight: 700; padding: 4px 8px; margin-bottom: 8px; font-size: 9pt; }
</style></head><body>
${draft ? `<div class="banner">DRAFT — ${model.unconfirmed} of ${model.total} items not human-confirmed (shown in red). Do not send.</div>` : ''}
<h1>${esc(h.name)}</h1>
${h.title ? `<div class="sub">${esc(h.title)}</div>` : ''}
<div class="contacts">${contacts}</div>
${body.join('\n')}
</body></html>
`;
}

export function renderMarkdown(data, model, resumeId) {
  const draft = model.unconfirmed > 0;
  const h = data.header || {};
  const m = (i) => (i.ok ? '✅' : i.status === 'STALE' ? '⚠️' : '❌');
  const tag = (i) => `${m(i)} \`${i.id ?? 'no-bead'}\``;
  const out = [];
  if (draft) out.push(`> **DRAFT** — ${model.unconfirmed} of ${model.total} items not human-confirmed (❌ unconfirmed, ⚠️ edited since confirmed).`, '');
  out.push(`# ${h.name}`, '');
  if (h.title) out.push(h.title, '');
  out.push((h.contacts || []).map((c) => `[${c.label}](${c.url})`).join(' · '), '');
  for (const s of model.sections) {
    out.push(`## ${s.title}`, '');
    if (s.kind === 'prose') out.push(`${s.item.text} ${tag(s.item)}`, '');
    for (const e of s.entries || []) {
      out.push(`### ${e.head.text} ${tag(e.head)}`, '');
      if (e.meta) out.push(`*${e.meta}*`, '');
      for (const b of e.bullets) out.push(`- ${b.text} ${tag(b)}`);
      out.push('');
    }
    if (s.kind === 'list') out.push(...s.items.map((i) => `- ${i.text} ${tag(i)}`), '');
  }
  out.push(`<!-- built from ${resumeId} -->`);
  return out.join('\n');
}

async function main(argv) {
  const id = argv.find((a) => !a.startsWith('--'));
  const noPdf = argv.includes('--no-pdf');
  if (!id) {
    console.error('usage: node build-bead-resume.mjs <resume-bead-id> [--no-pdf]');
    return 2;
  }
  if (!existsSync(DATA_PY)) {
    console.error(`✗ ${DATA_PY} missing — the copied resume-docx tooling is not installed`);
    return 4;
  }

  let data;
  let idx;
  try {
    data = JSON.parse(execFileSync(PY, [DATA_PY, id], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    idx = statusIndex();
  } catch (e) {
    console.error(`✗ failed to resolve ${id}\n${e.stderr || e.message}`);
    return 4;
  }

  const model = buildModel(data, idx);
  const draft = model.unconfirmed > 0;
  const date = new Date().toISOString().slice(0, 10);
  const base = `${draft ? 'DRAFT_' : ''}${(data.header?.name || 'Resume').replace(/\s+/g, '_')}_Resume_${id}_${date}`;
  const dir = join(ROOT, 'output', 'resumes');
  mkdirSync(dir, { recursive: true });

  const html = renderHtml(data, model, id);
  writeFileSync(join(dir, `${base}.html`), html);
  writeFileSync(join(dir, `${base}.md`), renderMarkdown(data, model, id) + '\n');
  console.log(`✓ ${base}.html\n✓ ${base}.md`);

  if (!noPdf) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.pdf({ path: join(dir, `${base}.pdf`), format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    } finally {
      await browser.close();
    }
    console.log(`✓ ${base}.pdf`);
  }
  console.log(draft
    ? `DRAFT: ${model.unconfirmed} of ${model.total} items unconfirmed (red). Output in ${dir}`
    : `All ${model.total} items confirmed. Output in ${dir}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
