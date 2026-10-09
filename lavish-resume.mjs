#!/usr/bin/env node

/**
 * lavish-resume.mjs — render any bead-backed résumé as a Lavish review page.
 *
 * Give it a résumé bead id; it resolves the bead ids itself (resume-data.py),
 * reads every store for each bead's CURRENT confirmation state, and writes a
 * self-contained HTML page where every piece of text is tagged with the bead
 * that backs it:
 *
 *   data-bead="resume_bullets-rzy6.2"  data-store  data-status
 *
 * Open it with `lavish-axi`; when you annotate text or an element, the agent
 * sees the selector plus the visible bead-id chip and can tell exactly which
 * bead the feedback is about. Edits belong in the BEADS (never the HTML,
 * never cv.md); editing a bead makes its confirmation stale, so a human
 * re-confirms. This script only reads: no bead is written, nothing is sent.
 *
 * Outputs (default dir .lavish/):
 *   <id>.html         the review page
 *   <id>.beads.json   the collected inventory: every bead id, store, status,
 *                     labels, where it is used, and its text
 *
 * Usage:   node lavish-resume.mjs <resume-bead-id> [--out=<dir>] [--open]
 *          --open runs `lavish-axi <html>` afterwards
 * Env:     RESUME_PY (python with PyYAML), RESUME_PII_DIR
 * Exit:    0 written · 2 usage · 4 resolve failed
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildModel } from './build-bead-resume.mjs';
import { classifyBead, readStore, loadCorpus, mapPayload } from './resume-beads.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_PY = join(ROOT, 'local', 'resume-beads', 'resume-data.py');
const PY = process.env.RESUME_PY || join(homedir(), '.pyenv/shims/python3');
const STORES = ['resume_bullets', 'projects', 'employment', 'education', 'career'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/** id -> { store, status, title, labels } for every bead in the résumé stores. */
function beadIndex() {
  const idx = new Map();
  for (const store of STORES) {
    const r = readStore(store);
    if (!r.ok) throw new Error(`cannot read store ${store}: ${r.reason}`);
    for (const b of r.beads) {
      idx.set(b.id, { store, status: classifyBead(b).status, title: b.title || '', labels: b.labels || [] });
    }
  }
  return idx;
}

/** Document-order list of every item in the model, each tagged with its section. */
function flatten(model) {
  const out = [];
  for (const s of model.sections) {
    if (s.item) out.push({ section: s.title, role: 'prose', ...s.item });
    for (const e of s.entries || []) {
      out.push({ section: s.title, role: 'heading', ...e.head });
      for (const b of e.bullets) out.push({ section: s.title, role: 'bullet', ...b });
    }
    for (const i of s.items || []) out.push({ section: s.title, role: 'line', ...i });
  }
  return out;
}

/** The collected inventory: one record per distinct bead, plus items with no bead. */
export function collectBeads(model, idx) {
  const byId = new Map();
  const unmapped = [];
  for (const it of flatten(model)) {
    if (!it.id) {
      unmapped.push({ section: it.section, role: it.role, text: it.text });
      continue;
    }
    const meta = idx.get(it.id) || {};
    const rec = byId.get(it.id) || {
      id: it.id,
      store: meta.store ?? it.id.replace(/-[^-]+$/, ''),
      status: it.status,
      title: meta.title ?? '',
      labels: meta.labels ?? [],
      uses: [],
    };
    rec.uses.push({ section: it.section, role: it.role, text: it.text });
    byId.set(it.id, rec);
  }
  return { beads: [...byId.values()], unmapped };
}

export const GLYPH = { CONFIRMED: '✅', STALE: '⚠️', UNCONFIRMED: '❌' };
const LABEL = { CONFIRMED: 'confirmed', STALE: 'edited since confirmed', UNCONFIRMED: 'unconfirmed' };

export function renderPage(data, model, inv, idx, resumeId) {
  const h = data.header || {};
  const tag = (it, extra = '') => {
    const meta = it.id ? idx.get(it.id) : null;
    const attrs = it.id
      ? `data-bead="${esc(it.id)}" data-store="${esc(meta?.store ?? '')}" data-status="${esc(it.status)}"`
      : 'data-bead="" data-status="UNMAPPED"';
    return `${attrs}${extra}`;
  };
  const chip = (it) => (it.id
    ? `<code class="bid s-${esc(it.status)}" title="${esc(LABEL[it.status] ?? it.status)}">${GLYPH[it.status] ?? ''} ${esc(it.id)}</code>`
    : '<code class="bid s-UNMAPPED" title="no bead backs this text">no bead</code>');
  const cls = (it) => `item s-${it.id ? it.status : 'UNMAPPED'}`;

  const body = [];
  for (const s of model.sections) {
    body.push(`<h2>${esc(s.title)}</h2>`);
    if (s.kind === 'prose') body.push(`<p ${tag(s.item)} class="${cls(s.item)}">${inline(s.item.text)} ${chip(s.item)}</p>`);
    for (const e of s.entries || []) {
      body.push(`<div class="entry"><div class="head ${cls(e.head)}" ${tag(e.head)}><h3>${inline(e.head.text)}</h3><span class="meta">${esc(e.meta)}</span>${chip(e.head)}</div><ul>`);
      for (const b of e.bullets) body.push(`<li ${tag(b)} class="${cls(b)}">${inline(b.text)} ${chip(b)}</li>`);
      body.push('</ul></div>');
    }
    if (s.kind === 'list') body.push('<ul>' + s.items.map((i) => `<li ${tag(i)} class="${cls(i)}">${inline(i.text)} ${chip(i)}</li>`).join('') + '</ul>');
  }

  const counts = { CONFIRMED: 0, STALE: 0, UNCONFIRMED: 0 };
  for (const b of inv.beads) counts[b.status] = (counts[b.status] ?? 0) + 1;
  const rows = inv.beads.map((b) => `<tr data-bead="${esc(b.id)}" data-status="${esc(b.status)}" class="s-${esc(b.status)}">
<td><code class="tid">${esc(b.id)}</code></td><td>${GLYPH[b.status] ?? ''} ${esc(LABEL[b.status] ?? b.status)}</td>
<td>${b.uses.length}× ${esc([...new Set(b.uses.map((u) => u.section))].join(', '))}</td>
<td class="lab">${esc(b.labels.filter((l) => !l.startsWith('confirmed:')).join(' '))}</td></tr>`).join('\n');
  const unmapped = inv.unmapped.length
    ? `<p class="warn">${inv.unmapped.length} item(s) are not backed by any bead (shown with a "no bead" chip). Their wording has no source to edit; they need a bead first.</p>`
    : '';
  const contacts = (h.contacts || []).map((c) => esc(c.label)).join(' · ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(h.name)} résumé review — ${esc(resumeId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root { --bg: #fafaf8; --fg: #1a1a1a; --mut: #666; --line: #d8d8d2; --red: #b00020; --amber: #8a5a00; --green: #1b6e2e; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #17181a; --fg: #e8e8e6; --mut: #9a9a96; --line: #34363a; --red: #ff6b7d; --amber: #e0a43a; --green: #5cc27a; --card: #1f2023; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 64px; display: grid; gap: 24px; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
  @media (max-width: 900px) { .wrap { grid-template-columns: minmax(0, 1fr); } }
  :where(p, h1, h2, h3, li, td, th, code) { overflow-wrap: anywhere; }
  .paper { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 24px 28px; }
  h1 { font-size: 24px; margin: 0; } .sub { color: var(--mut); } .contacts { font-size: 13px; color: var(--mut); }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--line); margin: 22px 0 6px; padding-bottom: 3px; }
  h3 { font-size: 15px; margin: 0; } .head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; margin-top: 10px; }
  .meta { color: var(--mut); font-size: 13px; margin-left: auto; }
  ul { margin: 4px 0 0; padding-left: 20px; } li { margin: 4px 0; } p { margin: 6px 0; }
  .item { border-radius: 4px; } .item:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .s-UNCONFIRMED, .s-STALE { color: var(--red); }
  .s-UNMAPPED { color: var(--amber); }
  .bid { display: inline-block; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 6px; border: 1px solid var(--line); border-radius: 10px; color: var(--mut); background: transparent; white-space: nowrap; }
  .bid.s-UNCONFIRMED, .bid.s-STALE { border-color: var(--red); color: var(--red); }
  .bid.s-CONFIRMED { border-color: var(--green); color: var(--green); }
  .bid.s-UNMAPPED { border-color: var(--amber); color: var(--amber); }
  aside .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  aside h2 { margin-top: 0; }
  .tally { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 14px; }
  .warn { color: var(--amber); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; } th { text-align: left; color: var(--mut); font-weight: 600; }
  th, td { padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td code { font-size: 11px; } td .tid { white-space: nowrap; overflow-wrap: normal; } td:nth-child(2) { white-space: nowrap; } td.lab { color: var(--mut); }
  .banner { border: 1.5px solid var(--red); color: var(--red); font-weight: 700; padding: 6px 10px; border-radius: 6px; margin-bottom: 14px; font-size: 13px; }
  .how { font-size: 13px; color: var(--mut); }
</style></head><body>
<div class="wrap">
<main class="paper">
${model.unconfirmed > 0 ? `<div class="banner">DRAFT — ${model.unconfirmed} of ${model.total} items are not human-confirmed (red). Do not send.</div>` : ''}
<h1>${esc(h.name)}</h1>
${h.title ? `<div class="sub">${esc(h.title)}</div>` : ''}
<div class="contacts">${contacts}</div>
${body.join('\n')}
</main>
<aside>
<div class="card">
<h2>Review ${esc(resumeId)}</h2>
<div class="tally"><span>✅ ${counts.CONFIRMED} confirmed</span><span>⚠️ ${counts.STALE} stale</span><span>❌ ${counts.UNCONFIRMED} unconfirmed</span><span>${inv.beads.length} beads</span></div>
${unmapped}
<p class="how">Select text or click an item and say what should change. The id chip names the bead; edits are made in the bead, which makes its confirmation stale. Confirming stays a human step.</p>
</div>
<div class="card">
<h2>Beads in this résumé</h2>
<table><thead><tr><th>Bead</th><th>State</th><th>Used</th><th>Labels</th></tr></thead><tbody>
${rows}
</tbody></table>
</div>
</aside>
</div>
</body></html>
`;
}


// ── payload mode: the PDF's own HTML, annotated ─────────────────────────────

export const unescapeHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
export const norm = (s) => unescapeHtml(String(s)).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const PAYLOAD_CSS = `
<style id="lavish-overlay">
  [data-bead] { position: relative; }
  [data-status="UNCONFIRMED"], [data-status="STALE"] { box-shadow: -3px 0 0 #c00000; }
  [data-status="CONFIRMED"] { box-shadow: -3px 0 0 #1a7f37; }
  [data-status="UNMAPPED"] { box-shadow: -3px 0 0 #b26a00; }
  .lv-chip { font: 9px/1.3 ui-monospace, Menlo, monospace; padding: 0 5px; margin-left: 6px; border: 1px solid; border-radius: 8px; white-space: nowrap; vertical-align: middle; }
  .lv-chip.UNCONFIRMED, .lv-chip.STALE { color: #c00000; } .lv-chip.CONFIRMED { color: #1a7f37; } .lv-chip.UNMAPPED, .lv-chip.REWORDED { color: #b26a00; }
  .lv-panel { position: fixed; top: 8px; right: 8px; width: 230px; max-height: 90vh; overflow: auto; font: 12px/1.4 -apple-system, Helvetica, sans-serif; background: #fff; color: #111; border: 1px solid #999; border-radius: 8px; padding: 10px; z-index: 9; box-shadow: 0 2px 10px rgba(0,0,0,.15); }
  .lv-panel h4 { margin: 0 0 6px; font-size: 12px; } .lv-panel ul { margin: 4px 0; padding-left: 16px; } .lv-panel li { margin: 2px 0; }
  @media screen { body { padding-right: 260px; } }
  body.lv-hide .lv-chip { display: none; } body.lv-hide [data-bead] { box-shadow: none; }
  @media print { .lv-panel, .lv-chip { display: none !important; } [data-bead] { box-shadow: none !important; } }
</style>`;

/** Render the payload with the real CV template, then tag every mapped line with its bead. */
export function renderPayloadPage(payloadPath) {
  const tmp = join(ROOT, '.lavish', '.payload-render.html');
  mkdirSync(dirname(tmp), { recursive: true });
  const template = execFileSync('node', [join(ROOT, 'cv-templates.mjs'), 'resolve', 'cv'], { encoding: 'utf8' }).trim();
  execFileSync('node', [join(ROOT, 'build-cv-html.mjs'), payloadPath, tmp, template], { stdio: ['ignore', 'ignore', 'inherit'] });
  let html = readFileSync(tmp, 'utf8');

  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const { corpus } = loadCorpus(STORES);
  const map = mapPayload(payload, corpus);
  const byText = new Map(map.rows.map((r) => [norm(r.text), r]));

  const best = (r) => (r?.beads?.length ? r.beads[0] : null);
  const tagAttrs = (b) => (b
    ? `data-bead="${esc(b.id)}" data-store="${esc(b.store)}" data-status="${esc(b.status)}" data-match="${b.containment ?? ''}"`
    : 'data-bead="" data-status="UNMAPPED"');
  const chipFor = (b, extra = '') => (b
    ? `<code class="lv-chip ${b.status === 'CONFIRMED' && b.containment < 1 ? 'REWORDED' : esc(b.status)}" title="${esc(b.title)} — text match ${Math.round((b.containment ?? 0) * 100)}%${extra}">${GLYPH[b.status] ?? ''} ${esc(b.id)}${b.containment < 1 ? ` ~${Math.round(b.containment * 100)}%` : ''}</code>`
    : '<code class="lv-chip UNMAPPED" title="no bead backs this exact text">no bead</code>');

  const seen = [];
  const annotate = (re, open) => {
    html = html.replace(re, (m, ...g) => {
      const inner = g[g.length - 3 + 0] ?? g[0];
      const row = byText.get(norm(inner));
      const b = best(row);
      seen.push({ text: unescapeHtml(inner), bead: b });
      return open(m, inner, b);
    });
  };
  annotate(/<li>([\s\S]*?)<\/li>/g, (m, inner, b) => `<li ${tagAttrs(b)}>${inner}${chipFor(b)}</li>`);
  annotate(/<div class="summary-text">([\s\S]*?)<\/div>/g, (m, inner, b) => `<div class="summary-text" ${tagAttrs(b)}>${inner}${chipFor(b)}</div>`);
  annotate(/<div class="skill-item">([\s\S]*?)<\/div>/g, (m, inner, b) => `<div class="skill-item" ${tagAttrs(b)}>${inner}${chipFor(b)}</div>`);

  // Employment frames: tag each job header with the frame bead for its company.
  const frameFor = new Map(map.frames.map((f) => [norm(f.section), best(f)]));
  html = html.replace(/<div class="job-header">\s*<span class="job-company">([\s\S]*?)<\/span>/g, (m, company) => {
    const b = frameFor.get(norm(company)) ?? null;
    seen.push({ text: `[frame] ${unescapeHtml(company)}`, bead: b });
    return m.replace('<div class="job-header">', `<div class="job-header" ${tagAttrs(b)}>`).replace('</span>', `</span>${chipFor(b)}`);
  });

  const t = { CONFIRMED: 0, STALE: 0, UNCONFIRMED: 0, UNMAPPED: 0 };
  for (const x of seen) t[x.bead ? x.bead.status : 'UNMAPPED'] += 1;
  const gaps = seen.filter((x) => !x.bead).map((x) => `<li>${esc(x.text.slice(0, 80))}…</li>`).join('');
  const panel = `<div class="lv-panel"><h4>Bead review — ${esc(basename(payloadPath))}</h4>
<div>✅ ${t.CONFIRMED} · ⚠️ ${t.STALE} · ❌ ${t.UNCONFIRMED} · no bead ${t.UNMAPPED}</div>
<label><input type="checkbox" checked onchange="document.body.classList.toggle('lv-hide',!this.checked)"> show bead chips</label>
<p>This is the exact HTML the PDF is rendered from. An amber ~NN% chip means the closest bead is confirmed but this wording differs from it, so the confirmation does not cover the line as sent.</p>
${gaps ? `<b>No bead:</b><ul>${gaps}</ul>` : ''}</div>`;
  html = html.replace('</head>', `${PAYLOAD_CSS}</head>`).replace('</body>', `${panel}</body>`);
  return { html, seen, tally: t };
}

async function main(argv) {
  const payloadArg = argv.find((a) => a.startsWith('--payload='));
  if (payloadArg) {
    const pp = resolve(payloadArg.slice(10));
    const od = resolve((argv.find((a) => a.startsWith('--out=')) || '--out=.lavish').slice(6));
    mkdirSync(od, { recursive: true });
    const { html, tally } = renderPayloadPage(pp);
    const hp = join(od, `${basename(pp, '.json')}.html`);
    writeFileSync(hp, html);
    console.log(`✓ ${hp}\n✅ ${tally.CONFIRMED} · ⚠️ ${tally.STALE} · ❌ ${tally.UNCONFIRMED} · no bead ${tally.UNMAPPED}`);
    if (argv.includes('--open')) execFileSync('lavish-axi', [hp], { stdio: 'inherit' });
    else console.log(`Open it:  lavish-axi ${hp}`);
    return 0;
  }
  const id = argv.find((a) => !a.startsWith('--'));
  const outArg = argv.find((a) => a.startsWith('--out='));
  const open = argv.includes('--open');
  if (!id) {
    console.error('usage: node lavish-resume.mjs <resume-bead-id> [--out=<dir>] [--open]');
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
    idx = beadIndex();
  } catch (e) {
    console.error(`✗ failed to resolve ${id}\n${e.stderr || e.message}`);
    return 4;
  }

  const statusOf = new Map([...idx].map(([k, v]) => [k, v.status]));
  const model = buildModel(data, statusOf);
  const inv = collectBeads(model, idx);

  const dir = resolve(outArg ? outArg.slice(6) : '.lavish');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, `${id}.html`);
  const jsonPath = join(dir, `${id}.beads.json`);
  writeFileSync(htmlPath, renderPage(data, model, inv, idx, id));
  writeFileSync(jsonPath, JSON.stringify({ resume: id, generated: new Date().toISOString(), ...inv }, null, 2) + '\n');

  console.log(`✓ ${htmlPath}\n✓ ${jsonPath}`);
  console.log(`${inv.beads.length} beads collected · ${model.unconfirmed} of ${model.total} items unconfirmed · ${inv.unmapped.length} without a bead`);
  if (open) {
    execFileSync('lavish-axi', [htmlPath], { stdio: 'inherit' });
  } else {
    console.log(`Open it:  lavish-axi ${htmlPath}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
