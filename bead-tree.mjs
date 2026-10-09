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

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { GLYPH } from './lavish-resume.mjs';
import { beadIndex, loadSidecar } from './payload-beads.mjs';
import { readStore } from './resume-beads.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PAYLOAD_ONLY = 'bound in payload, not in résumé bead';

const SIDECAR_SECTION = (ref) => {
  if (ref === 'summary') return 'summary';
  const m = /^(\w+)\[/.exec(ref);
  return m ? m[1] : ref;
};

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
  const manifest = new Map(); // bead id -> node, for merging sidecar edges in
  const sections = root ? parseManifest(root.bead) : {};
  for (const [name, entries] of Object.entries(sections)) {
    const group = { id: null, label: name, origin: 'manifest', status: null, children: [], group: true };
    for (const e of entries) {
      if (e.bead) {
        const n = { ...nodeFor(e.bead, idx), ref: e.ref, origin: 'manifest' };
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
        return known;
      }
      const n = { ...nodeFor(b.bead, idx), ref, origin: 'payload', note: PAYLOAD_ONLY, source: b.source };
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
        const n = known ?? { ...nodeFor(b.bead, idx), ref, origin: 'payload', note: parent.origin === 'payload' ? PAYLOAD_ONLY : 'bound in payload, not listed in the manifest', source: b.source };
        if (known) known.origin = 'both';
        if (!parent.children.includes(n)) parent.children.push(n);
      } else {
        place(ref, b);
      }
    }
    for (const g of orphanGroups.values()) rootNode.children.push(g);
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
    return `<li class="bt-group"><span class="bt-gname">${esc(n.label)}</span>${n.children.length ? `<ul>${n.children.map(renderNode).join('')}</ul>` : ''}</li>`;
  }
  const glyph = GLYPH[n.status] ?? (n.status === 'UNRESOLVED' || n.status === 'MISSING' ? '∅' : '');
  const id = n.id ? `<code class="bt-id" data-bead="${esc(n.id)}">${esc(n.id)}</code>` : `<code class="bt-id">${esc(n.label)}</code>`;
  const tag = n.origin === 'payload' && n.note === PAYLOAD_ONLY
    ? `<span class="bt-tag bt-payload">${PAYLOAD_ONLY}</span>`
    : n.origin === 'payload' ? `<span class="bt-tag bt-payload">${esc(n.note)}</span>`
    : n.origin === 'both' ? '<span class="bt-tag bt-both">résumé bead + payload</span>'
    : n.note ? `<span class="bt-tag bt-warn">${esc(n.note)}</span>` : '';
  const title = n.title ? ` <span class="bt-title">${esc(n.title)}</span>` : '';
  return `<li class="bt-node ${esc(n.status)}" title="${esc(ORIGIN_TITLE[n.origin] ?? '')}"><span class="bt-chip">${glyph}</span> ${id}${title} ${tag}${n.children.length ? `<ul>${n.children.map(renderNode).join('')}</ul>` : ''}</li>`;
}

export const TREE_CSS = `
<style id="bead-tree-css">
  #lv-tree { font: 12px/1.45 -apple-system, system-ui, sans-serif; border: 1px solid #ccc; background: #fafafa; color: #222; margin: 24px auto; padding: 10px 14px; max-width: 8.5in; }
  #lv-tree h4 { margin: 0 0 6px; font-size: 13px; }
  #lv-tree ul { list-style: none; margin: 2px 0 2px 14px; padding-left: 12px; border-left: 1px solid #bbb; }
  #lv-tree > ul { margin-left: 0; border-left: 0; padding-left: 0; }
  #lv-tree .bt-gname { font-weight: 600; color: #555; }
  #lv-tree .bt-id { font-size: 11px; }
  #lv-tree .bt-title { color: #666; }
  #lv-tree .bt-tag { font-size: 10px; padding: 0 5px; border-radius: 3px; margin-left: 4px; }
  #lv-tree .bt-payload { background: #fff1d6; color: #8a4b00; }
  #lv-tree .bt-both { background: #e3f1e6; color: #1a5c2a; }
  #lv-tree .bt-warn { background: #eee; color: #555; }
  #lv-tree .UNCONFIRMED > .bt-id, #lv-tree .STALE > .bt-id { color: #c00000; }
  @media print { #lv-tree { display: none !important; } }
</style>`;

/** The tree as one element with id lv-tree (swappable out of band). */
export function renderTree(root, { oob = false } = {}) {
  const beads = flattenTree(root);
  const payloadOnly = beads.filter((n) => n.origin === 'payload').length;
  const head = `<h4>Bead tree — ${esc(root.id)} <span class="bt-title">${esc(root.title)}</span></h4>
<div>${beads.length - 1} connected bead(s)${payloadOnly ? ` · <span class="bt-tag bt-payload">${payloadOnly} ${PAYLOAD_ONLY}</span>` : ''}</div>`;
  const rootLi = `<li class="bt-node ${esc(root.status)}"><span class="bt-chip">${GLYPH[root.status] ?? (root.status === 'MISSING' ? '∅' : '')}</span> <code class="bt-id">${esc(root.id)}</code>${root.children.length ? `<ul>${root.children.map(renderNode).join('')}</ul>` : ''}</li>`;
  return `<div id="lv-tree"${oob ? ' hx-swap-oob="outerHTML"' : ''}>${head}<ul>${rootLi}</ul></div>`;
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
  const [resumeId, payload] = process.argv.slice(2);
  if (!resumeId) {
    console.error('usage: node bead-tree.mjs <resume-bead-id> [payload.json]');
    process.exitCode = 2;
  } else {
    const side = payload ? loadSidecar(payload) : null;
    console.log(text(buildTree(resumeId, beadIndex(), side)));
  }
}
