#!/usr/bin/env node

/**
 * bead-tree.mjs — the bead graph behind a résumé as a DESCENDING TREE.
 *
 * TOP = the résumé bead (e.g. resumes-61s). Beneath it, two kinds of edge:
 *
 *   manifest  the résumé bead's own description JSON: sections.<name>[].bead
 *             (read directly — resume-data.py refuses a manifest whose
 *             careerSummary bead is prose, which is exactly the case to show)
 *   payload   the sidecar (payload-beads.mjs): ref -> bead for a tailored payload
 *
 * A bead the payload binds but the résumé bead does not reference is not hidden
 * and not silently adopted: it is marked "bound in payload, not in résumé bead".
 * Attaching it to the manifest is a human act this module never performs.
 *
 * Nesting: a role's frame bead holds its bullets (experience[i]#frame ->
 * experience[i].bullets[j]).
 *
 * Usage:  node bead-tree.mjs <resume-bead-id> [payload.json]
 */

import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { GLYPH } from './lavish-resume.mjs';
import { beadIndex, loadSidecar } from './payload-beads.mjs';
import { readStore } from './resume-beads.mjs';
import { FAIL_LABEL, NOTE_MARK, checkBead, checkManifest, roleOfRef, roleOfSection } from './bead-typecheck.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PAYLOAD_ONLY = 'bound in payload, not in résumé bead';

const SIDECAR_SECTION = (ref) => {
  if (ref === 'summary') return 'summary';
  const m = /^(\w+)\[/.exec(ref);
  return m ? m[1] : ref;
};

/** The job bead a résumé bead's manifest points at (posting_ref). Fail-soft. */
export function loadJobBead(resumeBead) {
  let ref = null;
  try { ref = JSON.parse(resumeBead?.description || '{}').posting_ref || null; } catch { /* not JSON */ }
  if (!ref) return { ref: null, bead: null };
  try {
    const out = execFileSync(join(homedir(), '.local', 'bin', 'job'), ['show', ref, '--json'], { encoding: 'utf8', timeout: 30000 });
    return { ref, bead: JSON.parse(out)[0] || null };
  } catch {
    return { ref, bead: null };
  }
}

function parseManifest(bead) {
  try {
    return JSON.parse(bead.description || '{}').sections || {};
  } catch {
    return {};
  }
}

const nodeFor = (id, idx, extra = {}) => {
  const hit = id ? idx.get(id) : null;
  return {
    id,
    store: hit?.store ?? null,
    title: hit?.bead.title ?? '',
    text: hit?.bead.description ?? '',
    status: hit ? hit.status : 'MISSING',
    children: [],
    ...extra,
  };
};

/**
 * Pure: the tree as data. `side` may be null (no payload).
 * Node: { id, ref, label, store, title, status, origin, note, children }
 * origin: 'resume' (root) | 'manifest' | 'both' | 'payload'.
 */
/** The bead the manifest names for careerSummary, or null. */
export function manifestSummaryBead(resumeBead) {
  const e = (resumeBead ? parseManifest(resumeBead).careerSummary : null) || [];
  return e.find((x) => x.bead)?.bead ?? null;
}

export function loadResumeBead(resumeId) {
  const r = readStore('resumes');
  if (!r.ok) throw new Error(`cannot read store resumes: ${r.reason}`);
  return r.beads.find((b) => b.id === resumeId) || null;
}

export function buildTree(resumeId, idx, side = null, resumeBead = loadResumeBead(resumeId)) {
  const root = resumeBead ? { bead: resumeBead } : null;
  const rootNode = {
    id: resumeId,
    title: resumeBead?.title ?? '',
    status: resumeBead ? 'RESUME' : 'MISSING',
    store: 'resumes',
    origin: 'resume',
    children: [],
  };
  // The job this résumé targets: the first child, so the chain reads job -> résumé content.
  const job = loadJobBead(resumeBead);
  if (job.ref) {
    rootNode.children.push({
      id: job.ref,
      store: 'job',
      title: job.bead?.title ?? '',
      text: job.bead?.description ?? '',
      status: job.bead ? 'JOB' : 'MISSING',
      origin: 'manifest',
      ref: 'posting_ref',
      note: job.bead ? `job · ${job.bead.status} · P${job.bead.priority}` : 'posting_ref points at a job bead that cannot be read',
      children: [],
    });
  }
  const manifest = new Map(); // bead id -> node, for merging sidecar edges in
  const sections = root ? parseManifest(root.bead) : {};
  for (const [name, entries] of Object.entries(sections)) {
    const group = { id: null, label: name, origin: 'manifest', status: null, children: [], group: true };
    for (const e of entries) {
      if (e.bead) {
        const n = { ...nodeFor(e.bead, idx), ref: e.ref, origin: 'manifest', roles: [roleOfSection(name)] };
        group.children.push(n);
        manifest.set(e.bead, n);
      } else {
        group.children.push({ id: null, ref: e.ref, label: e.ref, status: 'UNRESOLVED', origin: 'manifest', note: 'manifest ref with no bead yet', children: [] });
      }
    }
    rootNode.children.push(group);
  }

  if (side) {
    const bindings = Object.entries(side.bindings);
    const frames = new Map(); // experience index -> node holding its bullets
    const orphanGroups = new Map();
    const place = (ref, b) => {
      const known = manifest.get(b.bead);
      if (known) {
        known.origin = 'both';
        known.payloadRef = ref;
        known.roles = [...(known.roles ?? []), roleOfRef(ref)];
        return known;
      }
      const superseded = ref === 'summary' && manifestSummaryBead(resumeBead) && manifestSummaryBead(resumeBead) !== b.bead;
      const n = { ...nodeFor(b.bead, idx), ref, origin: 'payload', roles: [roleOfRef(ref)], note: superseded ? 'stale sidecar binding — résumé bead names a different summary, which wins' : PAYLOAD_ONLY, source: b.source };
      const sec = SIDECAR_SECTION(ref);
      if (!orphanGroups.has(sec)) orphanGroups.set(sec, { id: null, label: `payload · ${sec}`, origin: 'payload', status: null, children: [], group: true });
      orphanGroups.get(sec).children.push(n);
      return n;
    };
    // Frames first so bullets can nest under them.
    for (const [ref, b] of bindings) {
      const m = /^experience\[(\d+)\]#frame$/.exec(ref);
      if (m) frames.set(Number(m[1]), place(ref, b));
    }
    for (const [ref, b] of bindings) {
      if (/#frame$/.test(ref)) continue;
      const m = /^experience\[(\d+)\]\.bullets\[(\d+)\]$/.exec(ref);
      const parent = m ? frames.get(Number(m[1])) : null;
      if (parent) {
        const known = manifest.get(b.bead);
        const n = known ?? { ...nodeFor(b.bead, idx), ref, origin: 'payload', roles: ['bullet'], note: parent.origin === 'payload' ? PAYLOAD_ONLY : 'bound in payload, not listed in the manifest', source: b.source };
        if (known) { known.origin = 'both'; known.roles = [...(known.roles ?? []), 'bullet']; }
        if (!parent.children.includes(n)) parent.children.push(n);
      } else {
        place(ref, b);
      }
    }
    for (const g of orphanGroups.values()) rootNode.children.push(g);
  }
  // Type check: every bead stays in the tree; a failing one carries its problems for a red warning.
  if (resumeBead) rootNode.problems = checkManifest(resumeBead);
  for (const n of flattenTree(rootNode)) {
    const hit = n.id ? idx.get(n.id) : null;
    if (!hit || !n.roles) continue;
    const probs = [...new Set(n.roles.filter(Boolean).flatMap((r) => checkBead(r, hit.bead)))];
    if (probs.length) n.problems = probs;
  }
  return rootNode;
}

export function flattenTree(node, out = []) {
  if (node.id) out.push(node);
  for (const c of node.children) flattenTree(c, out);
  return out;
}

const ORIGIN_TITLE = { manifest: 'in the résumé bead only', both: 'in the résumé bead and bound in the payload', payload: PAYLOAD_ONLY };

function renderNode(n) {
  if (n.group) {
    const key = `g:${n.label}`;
    return `<li class="bt-group${n.origin === 'payload' ? ' bt-pg' : ''}"><details open data-k="${esc(key)}"><summary class="bt-gname">${esc(n.label)} <span class="bt-count">${n.children.length}</span></summary>${n.children.length ? `<ul>${n.children.map(renderNode).join('')}</ul>` : ''}</details></li>`;
  }
  const glyph = n.status === 'JOB' ? '💼' : (GLYPH[n.status] ?? (n.status === 'UNRESOLVED' || n.status === 'MISSING' ? '∅' : ''));
  const id = n.id ? `<code class="bt-id" data-bead="${esc(n.id)}">${esc(n.id)}</code>` : `<code class="bt-id">${esc(n.label)}</code>`;
  const tag = n.origin === 'payload' && n.note === PAYLOAD_ONLY
    ? `<span class="bt-tag bt-payload">${PAYLOAD_ONLY}</span>`
    : n.origin === 'payload' ? `<span class="bt-tag bt-payload">${esc(n.note)}</span>`
    : n.origin === 'both' ? '<span class="bt-tag bt-both">résumé bead + payload</span>'
    : n.note ? `<span class="bt-tag bt-warn">${esc(n.note)}</span>` : '';
  const title = n.title ? ` <span class="bt-title">${esc(n.title)}</span>` : '';
  const warn = n.problems?.length ? `<div class="bt-fail" title="${esc(n.problems.join('; '))}">⚠ does not pass type check: ${esc(n.problems.join('; '))}</div>` : '';
  const conf = /^auto@([\d.]+)$/.exec(n.source ?? '');
  const score = conf ? Number(conf[1]) : null;
  const badge = n.source
    ? `<span class="bt-conf${score !== null && score < 0.8 ? ' bt-weak' : ''}" title="binding ${esc(n.source)}${score !== null && score < 0.8 ? ' — weak text match, needs review' : ''}">${score !== null ? `<i style="width:${Math.round(score * 100)}%"></i>${score.toFixed(2)}` : esc(n.source)}</span>`
    : '';
  const looksYaml = /^\s*[\w.-]+:(\s|$)/.test(String(n.text ?? '')) && /\n\s*(- )?[\w.-]+:/.test(String(n.text ?? ''));
  const flat = String(n.text ?? '').replace(/\s+/g, ' ').trim();
  // Every record's text is collapsible; the job posting (long) starts collapsed.
  // One line per record: the summary IS the truncated text; clicking expands to the full text (YAML highlighted).
  const body = looksYaml ? `<pre class="bt-yaml">${highlightYaml(String(n.text).trim())}</pre>` : `<div class="bt-text">${esc(String(n.text).trim())}</div>`;
  const preview = flat ? `<details class="bt-textd" data-k="t:${esc(n.id ?? n.label)}"><summary class="bt-line" title="click to expand">${esc(flat.length > 140 ? `${flat.slice(0, 140)}…` : flat)}</summary>${body}</details>` : '';
  if (n.store === 'job' && flat) {
    // The job posting is long: the whole record collapses behind its own line, closed by default.
    return `<li class="bt-node ${esc(n.status)} bt-o-${esc(n.origin)}"><details data-k="j:${esc(n.id ?? n.label)}"><summary><span class="bt-chip">${glyph}</span> ${id}${title} ${tag}</summary><div class="bt-text" title="${esc(String(n.text).trim())}">${esc(flat.length > 600 ? `${flat.slice(0, 600)}…` : flat)}</div></details></li>`;
  }
  return `<li class="bt-node ${esc(n.status)} bt-o-${esc(n.origin)}" title="${esc(ORIGIN_TITLE[n.origin] ?? '')}"><span class="bt-chip">${glyph}</span> ${id}${title} ${tag}${badge}${warn}${preview}${n.children.length ? `<details open data-k="n:${esc(n.id ?? n.label)}"><summary class="bt-count">${n.children.length} bullet(s)</summary><ul>${n.children.map(renderNode).join('')}</ul></details>` : ''}</li>`;
}

/** Minimal YAML highlighter: keys, quoted strings, list dashes, comments. Input is escaped first. */
export function highlightYaml(src) {
  return src.split('\n').map((line) => {
    const e = esc(line);
    const m = /^(\s*(?:- )?)([\w.-]+)(:)(.*)$/.exec(e);
    if (m) return `${m[1]}<span class="y-k">${m[2]}</span>${m[3]}${yamlVal(m[4])}`;
    return yamlVal(e);
  }).join('\n');
}
function yamlVal(v) {
  if (/^\s*#/.test(v)) return `<span class="y-c">${v}</span>`;
  return v.replace(/(&quot;.*&quot;|&#39;.*&#39;)/, '<span class="y-s">$1</span>').replace(/^(\s*- )/, '<span class="y-d">$1</span>');
}

/** Keeps collapsed sections collapsed when /poll repaints the tree. */
export const TREE_JS = `<button id="bt-toggle" type="button" title="Show/hide bead tree" aria-label="Toggle bead tree">☰</button><script id="bead-tree-js">
(function () {
  var KEY = 'bt-hidden';
  try { if (localStorage.getItem(KEY) === '1') document.body.classList.add('bt-hidden'); } catch (e) {}
  document.getElementById('bt-toggle').addEventListener('click', function () {
    var h = document.body.classList.toggle('bt-hidden');
    try { localStorage.setItem(KEY, h ? '1' : '0'); } catch (e) {}
  });
  var state = {};
  document.body.addEventListener('toggle', function (e) {
    var d = e.target; if (!d || !d.dataset || !d.dataset.k) return;
    state[d.dataset.k] = d.open;
  }, true);
  document.body.addEventListener('htmx:oobAfterSwap', function (e) {
    var t = e.detail && e.detail.target; if (!t || t.id !== 'lv-tree') return;
    t.querySelectorAll('details[data-k]').forEach(function (d) { if (d.dataset.k in state) d.open = state[d.dataset.k]; });
  });
})();
</script>`;

export const TREE_CSS = `
<style id="bead-tree-css">
  #lv-tree { font: 12px/1.45 -apple-system, system-ui, sans-serif; border: 1px solid #ccc; background: #fafafa; color: #222; margin: 24px auto; padding: 10px 14px; max-width: 8.5in; }
  #lv-tree h4 { margin: 0 0 6px; font-size: 13px; padding-left: 28px; }
  #bt-toggle { position: fixed; top: 6px; left: 6px; z-index: 10; width: 26px; height: 26px; padding: 0; border: 1px solid #bbb; border-radius: 4px; background: #fff; cursor: pointer; font-size: 14px; line-height: 1; }
  body.bt-hidden #lv-tree { display: none; }
  #lv-tree ul { list-style: none; margin: 2px 0 2px 14px; padding-left: 12px; border-left: 1px solid #bbb; }
  #lv-tree > ul { margin-left: 0; border-left: 0; padding-left: 0; }
  #lv-tree .bt-gname { font-weight: 600; color: #555; }
  #lv-tree .bt-id { font-size: 11px; }
  #lv-tree summary { cursor: pointer; }
  #lv-tree .bt-textd { margin: 1px 0 3px 18px; }
  #lv-tree .bt-textd > summary { display: list-item; }
  #lv-tree .bt-text { color: #444; font-size: 11px; margin: 1px 0 3px 0; max-width: 70ch; }
  #lv-tree summary.bt-count, #lv-tree .bt-count { font-size: 10px; color: #777; font-weight: 400; }
  #lv-tree details > summary.bt-count { display: inline-block; margin-left: 6px; }
  #lv-tree .bt-title { color: #666; }
  #lv-tree .bt-fail { color: #b00020; background: #fdecee; border-left: 3px solid #b00020; font-size: 11px; font-weight: 600; margin: 2px 0 3px 18px; padding: 2px 6px; max-width: 70ch; }
  #lv-tree .bt-line { color: #555; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70ch; }
  #lv-tree .bt-yaml { margin: 2px 0 4px; padding: 6px 8px; background: #1e2430; color: #d6deeb; font: 11px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; border-radius: 4px; max-width: 70ch; }
  #lv-tree .y-k { color: #82aaff; } #lv-tree .y-s { color: #c3e88d; } #lv-tree .y-d { color: #ffcb6b; } #lv-tree .y-c { color: #7f8a9f; }
  #lv-tree .bt-tag { font-size: 10px; padding: 0 5px; border-radius: 3px; margin-left: 4px; }
  #lv-tree .bt-payload { background: #fff1d6; color: #8a4b00; }
  #lv-tree .bt-both { background: #e3f1e6; color: #1a5c2a; }
  #lv-tree .bt-warn { background: #eee; color: #555; }
  #lv-tree .bt-o-payload > ul, #lv-tree .bt-group.bt-pg > ul { border-left: 2px dashed #e0a030; }
  #lv-tree .bt-o-payload { border-left: 3px solid #e0a030; padding-left: 6px; margin: 2px 0; background: linear-gradient(90deg, #fff8e8, transparent 60%); }
  #lv-tree .bt-o-both { border-left: 3px solid #2e8b45; padding-left: 6px; margin: 2px 0; }
  #lv-tree .bt-o-manifest { border-left: 3px solid #888; padding-left: 6px; margin: 2px 0; }
  #lv-tree .bt-conf { display: inline-block; position: relative; min-width: 44px; height: 13px; line-height: 13px; font-size: 10px; margin-left: 4px; padding: 0 4px; border: 1px solid #ccc; border-radius: 3px; vertical-align: middle; overflow: hidden; }
  #lv-tree .bt-conf i { position: absolute; left: 0; top: 0; bottom: 0; background: #cfe8d5; z-index: 0; }
  #lv-tree .bt-conf.bt-weak { border-color: #c00000; color: #c00000; }
  #lv-tree .bt-conf.bt-weak i { background: #f5c8c8; }
  #lv-tree .bt-legend { margin-top: 8px; font-size: 10px; color: #555; }
  #lv-tree .bt-legend span { margin-right: 12px; padding-left: 6px; }
  #lv-tree .UNCONFIRMED > .bt-id, #lv-tree .STALE > .bt-id { color: #c00000; }
  /* Two columns from a 16" MacBook Pro viewport down to ~1280px: tree pinned left, résumé centred in the rest. */
  @media screen and (min-width: 1280px) {
    body { transition: padding-left .3s ease; }
    #lv-tree { transition: transform .3s ease; }
    body.bt-hidden { padding-left: 0 !important; }
    body.bt-hidden #lv-tree { display: block; transform: translateX(-100%); box-shadow: none; }
    body { --bt-w: clamp(400px, calc(100vw - 8.5in - 48px), 1100px); padding-left: var(--bt-w) !important; padding-right: 0 !important; box-sizing: border-box; }
    body > .page { max-width: 8.5in !important; margin: 0 auto !important; }
    #lv-tree { position: fixed; top: 0; left: 0; bottom: 0; width: var(--bt-w); margin: 0; max-width: none; overflow-y: auto; box-sizing: border-box; border-width: 0 1px 0 0; z-index: 5; }
  }
  @media print { body { padding-left: 0 !important; } #lv-tree { display: none !important; } }
</style>`;

/** The tree as one element with id lv-tree (swappable out of band). */
/**
 * Keeps the label `does-not-pass-type-check` and a notes line in step with the type check.
 * Only labels and notes change, never a description, so confirmation is unaffected.
 * Idempotent: it writes only when a bead's label state is wrong.
 */
export function syncTypeLabels(root, idx) {
  const done = { labelled: [], cleared: [] };
  const call = (store, args) => execFileSync(join(homedir(), '.local', 'bin', store), args, { encoding: 'utf8', timeout: 30000 });
  for (const n of flattenTree(root)) {
    const hit = n.id ? idx.get(n.id) : null;
    if (!hit || !n.roles) continue;
    const has = (hit.bead.labels || []).includes(FAIL_LABEL);
    const bad = Boolean(n.problems?.length);
    try {
      if (bad && !has) { call(hit.store, ['update', n.id, '--add-label', FAIL_LABEL, '--append-notes', `${NOTE_MARK} ${n.problems.join('; ')}`]); done.labelled.push(n.id); }
      else if (!bad && has) { call(hit.store, ['update', n.id, '--remove-label', FAIL_LABEL, '--append-notes', `${NOTE_MARK} passes now`]); done.cleared.push(n.id); }
    } catch { /* a store that refuses the write keeps its on-page warning */ }
  }
  return done;
}

export function renderTree(root, { oob = false } = {}) {
  const beads = flattenTree(root);
  const payloadOnly = beads.filter((n) => n.origin === 'payload').length;
  const failing = beads.filter((n) => n.problems?.length).length;
  const rootWarn = root.problems?.length ? `<div class="bt-fail">⚠ résumé bead does not pass type check: ${esc(root.problems.join('; '))}</div>` : '';
  const head = `<h4>Bead tree — ${esc(root.id)} <span class="bt-title">${esc(root.title)}</span></h4>
<div>${beads.length - 1} connected bead(s)${payloadOnly ? ` · <span class="bt-tag bt-payload">${payloadOnly} ${PAYLOAD_ONLY}</span>` : ''}${failing ? ` · <span class="bt-fail" style="display:inline;margin:0">⚠ ${failing} fail type check</span>` : ''}</div>${rootWarn}`;
  const rootLi = `<li class="bt-node ${esc(root.status)}"><span class="bt-chip">${GLYPH[root.status] ?? (root.status === 'MISSING' ? '∅' : '')}</span> <code class="bt-id">${esc(root.id)}</code>${root.children.length ? `<ul>${root.children.map(renderNode).join('')}</ul>` : ''}</li>`;
  return `<div id="lv-tree"${oob ? ' hx-swap-oob="outerHTML"' : ''}>${head}<ul>${rootLi}</ul>
<div class="bt-legend"><span style="border-left:3px solid #888">résumé bead</span><span style="border-left:3px solid #2e8b45">both</span><span style="border-left:3px dashed #e0a030">payload sidecar only</span><span style="color:#c00000">red bar = weak match (&lt;0.80)</span></div></div>`;
}

function text(root) {
  const lines = [];
  const walk = (n, depth) => {
    const pad = '  '.repeat(depth);
    if (n.group) lines.push(`${pad}${n.label}`);
    else lines.push(`${pad}${GLYPH[n.status] ?? '∅'} ${n.id ?? n.label}  [${n.origin}]${n.note ? `  (${n.note})` : ''}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const sync = args.includes('--sync');
  const [resumeId, payload] = args.filter((x) => !x.startsWith('--'));
  if (!resumeId) {
    console.error('usage: node bead-tree.mjs <resume-bead-id> [payload.json]');
    process.exitCode = 2;
  } else {
    const side = payload ? loadSidecar(payload) : null;
    const idx = beadIndex();
    const tree = buildTree(resumeId, idx, side);
    console.log(text(tree));
    for (const n of flattenTree(tree)) if (n.problems?.length) console.log(`⚠ ${n.id}: ${n.problems.join('; ')}`);
    for (const p of tree.problems ?? []) console.log(`⚠ ${resumeId}: ${p}`);
    if (sync) console.log(JSON.stringify(syncTypeLabels(tree, idx)));
  }
}
