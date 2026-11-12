#!/usr/bin/env node

/**
 * payload-beads.mjs — explicit bead bindings for a tailored-CV payload, plus
 * drift detection and a deliberate "pull the bead's text" step.
 *
 * resume-beads.mjs finds the bead behind a bullet by TEXT MATCHING, so the link
 * is recomputed every run and editing a bead never reaches the payload. This
 * records the link once, in a sidecar next to the payload, and keeps the PDF
 * path untouched (build-cv-html.mjs still reads a plain payload):
 *
 *   output/payload-X.json          unchanged shape
 *   output/payload-X.beads.json    { version, bindings: { "<ref>": { bead, source } } }
 *
 * <ref> is the same path resume-beads.mjs reports: `summary`,
 * `experience[i].bullets[j]`, `skills[i]`, `awards[i]`, `education[i]`; a role's
 * frame bead is `experience[i]#frame`.
 *
 * DRIFT = the payload text differs from the bound bead's CURRENT description.
 * PULL  = copy the bead's description into the payload (summary and experience
 * bullets only, and only when the description is plain prose). Pull is never
 * automatic: a tailored bullet is often worded differently from its bead on
 * purpose, and a bead can carry a claim the payload deliberately left out.
 * Pulling replaces wording a human may have approved, so it is an explicit act.
 *
 * Bindings made by `bind` are `source: "auto@<containment>"` — a text match
 * frozen in place, not a confirmation. Edit the sidecar to correct one.
 *
 * Usage:
 *   node payload-beads.mjs bind   <payload.json>          create/extend the sidecar
 *   node payload-beads.mjs status <payload.json>          drift + approval per ref
 *   node payload-beads.mjs pull   <payload.json> <ref>    copy bead text into payload
 */

import * as yaml from 'js-yaml';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { classifyBead, loadCorpus, mapPayload, readStore } from './resume-beads.mjs';

export const STORES = ['resume_bullets', 'projects', 'employment', 'education', 'career'];

export const sidecarPath = (payloadPath) => payloadPath.replace(/\.json$/, '') + '.beads.json';

export function loadSidecar(payloadPath) {
  const p = sidecarPath(payloadPath);
  if (!existsSync(p)) return { version: 1, bindings: {} };
  const s = JSON.parse(readFileSync(p, 'utf8'));
  return { version: 1, bindings: s.bindings || {} };
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** id -> { store, bead, status, ... } over every résumé store, read fresh. */
export function beadIndex() {
  const idx = new Map();
  for (const store of STORES) {
    const r = readStore(store);
    if (!r.ok) throw new Error(`cannot read store ${store}: ${r.reason}`);
    for (const bead of r.beads) idx.set(bead.id, { store, bead, ...classifyBead(bead) });
  }
  return idx;
}

/** The payload text at a ref, or null when the ref has no single text to compare. */
export function textAt(payload, ref) {
  if (ref === 'summary') return payload.summary ?? null;
  const m = /^experience\[(\d+)\]\.bullets\[(\d+)\]$/.exec(ref);
  if (m) return payload.experience?.[+m[1]]?.bullets?.[+m[2]] ?? null;
  return null;
}

function setTextAt(payload, ref, text) {
  if (ref === 'summary') {
    payload.summary = text;
    return true;
  }
  const m = /^experience\[(\d+)\]\.bullets\[(\d+)\]$/.exec(ref);
  if (m && payload.experience?.[+m[1]]?.bullets) {
    payload.experience[+m[1]].bullets[+m[2]] = text;
    return true;
  }
  return false;
}

const normText = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/** A description that is a YAML-ish frame/skills block is not a bullet to paste. */
function isPlainProse(desc) {
  const d = String(desc ?? '').trim();
  if (!d || d.includes('\n')) return false;
  return !/^[A-Za-z_][\w-]*:\s*(-|$)/.test(d) && !/^(category|careerSummary|position):/.test(d);
}

/**
 * The summary text a career bead holds: plain prose as-is, or the "Experience"
 * item of a `careerSummary:` frame (the shape resume-data.py reads). null when
 * it is neither (e.g. a frame with no Experience item).
 */
export function summaryTextOf(desc) {
  const d = String(desc ?? '').trim();
  if (!d) return null;
  if (!/^careerSummary:/.test(d)) return isPlainProse(d) ? d : null;
  try {
    const items = yaml.load(d)?.careerSummary;
    const hit = Array.isArray(items) ? items.find((i) => /^experience$/i.test(String(i?.title ?? '').trim())) : null;
    const t = hit?.text ? String(hit.text).replace(/\s+/g, ' ').trim() : '';
    return t || null;
  } catch {
    return null;
  }
}

/**
 * The sidecar as it applies when a résumé bead is the authority: the bead its
 * manifest names for careerSummary wins over a frozen `summary` binding, so
 * repointing the manifest repoints the page. Pure; the sidecar file is untouched.
 */
export function withManifestSummary(side, summaryBeadId, resumeId) {
  if (!summaryBeadId || side.bindings.summary?.bead === summaryBeadId) return side;
  return { ...side, bindings: { ...side.bindings, summary: { bead: summaryBeadId, source: `manifest:${resumeId}` } } };
}

/**
 * The résumé bead's manifest owns which jobs appear and in what order
 * (sections.workExperience, top to bottom). Re-order and filter payload.experience
 * to match, and re-index the sidecar's experience[i] refs to follow. A payload
 * entry whose frame bead the manifest does not list is dropped; one with no frame
 * binding is kept last (it cannot be placed, and silently dropping it would lose
 * text). Manifest beads with no payload entry cannot be rendered and come back in
 * `missing`. Pure; neither file is written. No manifest list -> unchanged.
 */
export function withManifestExperience(payload, side, manifestBeadIds) {
  const ids = (manifestBeadIds || []).filter(Boolean);
  const entries = payload.experience || [];
  if (!ids.length || !entries.length) return { payload, side, missing: [], dropped: [] };
  const frameOf = (i) => side.bindings[`experience[${i}]#frame`]?.bead ?? null;
  const used = new Set();
  const order = [];
  const missing = [];
  for (const id of ids) {
    const i = entries.findIndex((_, k) => !used.has(k) && frameOf(k) === id);
    if (i < 0) missing.push(id);
    else { used.add(i); order.push(i); }
  }
  const dropped = [];
  entries.forEach((_, i) => {
    if (used.has(i)) return;
    if (frameOf(i)) dropped.push(frameOf(i));
    else order.push(i);
  });
  const newIndex = new Map(order.map((oldI, newI) => [oldI, newI]));
  const bindings = {};
  for (const [ref, v] of Object.entries(side.bindings)) {
    const m = ref.match(/^experience\[(\d+)\](.*)$/);
    if (!m) { bindings[ref] = v; continue; }
    const ni = newIndex.get(Number(m[1]));
    if (ni !== undefined) bindings[`experience[${ni}]${m[2]}`] = v;
  }
  return {
    payload: { ...payload, experience: order.map((i) => entries[i]) },
    side: { ...side, bindings },
    missing,
    dropped,
  };
}

/**
 * A section the résumé bead's manifest lists as an empty array is dropped from
 * the payload (and its bindings), so removing a section is a manifest edit and
 * the stale payload copy cannot bring it back. Only the sections named in
 * `names` are considered; a missing or non-empty manifest list changes nothing.
 */
export function withManifestEmptySections(payload, side, manifestSections, names = ['education']) {
  const gone = names.filter((n) => Array.isArray(manifestSections?.[n]) && manifestSections[n].length === 0 && payload[n]);
  if (!gone.length) return { payload, side };
  const next = { ...payload };
  for (const n of gone) delete next[n];
  const bindings = Object.fromEntries(Object.entries(side.bindings).filter(([ref]) => !gone.some((n) => ref.startsWith(`${n}[`))));
  return { payload: next, side: { ...side, bindings } };
}

/**
 * Leadership & Accolades come from the résumé bead's manifest: sections.awards
 * lists group beads (description `title: Speaking`, metadata.bullets = ordered
 * bullet bead ids); each bullet bead is one line of prose and may carry
 * metadata.url / metadata.link_label for its link. Replaces payload.awards and
 * drops its stale sidecar bindings. No manifest entry with a bead: untouched. Pure.
 */
export function withManifestAwards(payload, side, manifestSections, idx) {
  const groups = (manifestSections?.awards || []).map((e) => e?.bead).filter(Boolean);
  if (!groups.length) return { payload, side, missing: [] };
  const missing = [];
  const awards = [];
  for (const gid of groups) {
    const g = idx.get(gid)?.bead;
    if (!g) { missing.push(gid); continue; }
    const title = (String(g.description || '').match(/^\s*title:\s*(.+?)\s*$/m) || [])[1]?.replace(/^["']|["']$/g, '') || g.title;
    const bullets = [];
    for (const id of frameBulletIds(g) || []) {
      const b = idx.get(id)?.bead;
      if (!b) { missing.push(id); continue; }
      const text = String(b.description || '').trim();
      bullets.push(b.metadata?.url ? { text, url: b.metadata.url, link_label: b.metadata.link_label || 'Link' } : text);
    }
    awards.push({ title, bullets });
  }
  const bindings = Object.fromEntries(Object.entries(side.bindings).filter(([ref]) => !ref.startsWith('awards[')));
  return { payload: { ...payload, awards }, side: { ...side, bindings }, missing };
}

/** The ordered bullet bead ids a frame bead lists in metadata.bullets, or null. */
export function frameBulletIds(frameBead) {
  let v = frameBead?.metadata?.bullets;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return Array.isArray(v) && v.length ? v.map(String) : null;
}

/**
 * A job's frame bead owns the order and membership of its bullets
 * (metadata.bullets: bullet bead ids, top to bottom); each bullet bead owns only
 * its content. Re-order experience[i].bullets to match and re-index the sidecar's
 * experience[i].bullets[j] refs. A bullet bound to a bead the frame does not list
 * is dropped; an unbound one stays last. A frame with no list is untouched. A listed
 * bead the payload lacks is added from the bead's own text; one that is not a bead at all comes back in `missing`. Pure.
 */
export function withFrameBullets(payload, side, idx) {
  const missing = [];
  const bindings = { ...side.bindings };
  const experience = (payload.experience || []).map((entry, i) => {
    const ids = frameBulletIds(idx.get(side.bindings[`experience[${i}]#frame`]?.bead)?.bead);
    if (!ids) return entry;
    const bullets = entry.bullets || [];
    const beadOf = (j) => side.bindings[`experience[${i}].bullets[${j}]`]?.bead ?? null;
    const used = new Set();
    const order = []; // payload index, or {bead} for a bullet the frame lists that the payload lacks
    for (const id of ids) {
      const j = bullets.findIndex((_, k) => !used.has(k) && beadOf(k) === id);
      if (j >= 0) { used.add(j); order.push(j); }
      else if (idx.has(id)) order.push({ bead: id }); // new on the bead side: the page takes its text from the bead
      else missing.push(id);
    }
    bullets.forEach((_, j) => { if (!used.has(j) && !beadOf(j)) order.push(j); });
    for (const ref of Object.keys(bindings)) if (ref.startsWith(`experience[${i}].bullets[`)) delete bindings[ref];
    order.forEach((o, newJ) => {
      if (typeof o === 'object') { bindings[`experience[${i}].bullets[${newJ}]`] = { bead: o.bead, source: idx.get(o.bead).store }; return; }
      const b = side.bindings[`experience[${i}].bullets[${o}]`];
      if (b) bindings[`experience[${i}].bullets[${newJ}]`] = b;
    });
    return { ...entry, bullets: order.map((o) => (typeof o === 'object' ? idx.get(o.bead).bead.description.trim() : bullets[o])) };
  });
  return { payload: { ...payload, experience }, side: { ...side, bindings }, missing };
}

/** `position:` / `company:` as the frame bead's description states them, or null. */
export function frameFields(description) {
  const pick = (key) => {
    const m = String(description || '').match(new RegExp(`^\\s*[•*-]?\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  };
  return { role: pick('position'), company: pick('company'), location: pick('location') };
}

/**
 * A job's title and company line come from its frame bead, not the payload copy,
 * so renaming a role in the bead renames it on the page. Pure.
 */
export function withFrameFields(payload, side, idx) {
  const experience = (payload.experience || []).map((entry, i) => {
    const hit = idx.get(side.bindings[`experience[${i}]#frame`]?.bead);
    if (!hit) return entry;
    const f = frameFields(hit.bead.description);
    return { ...entry, ...(f.role ? { role: f.role } : {}), ...(f.company ? { company: f.company } : {}), ...(f.location ? { location: f.location } : {}) };
  });
  return { ...payload, experience };
}

/** Create the sidecar, or add bindings for refs it lacks. Never overwrites one. */
export function bindPayload(payloadPath, { write = true } = {}) {
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const { corpus } = loadCorpus(STORES);
  const map = mapPayload(payload, corpus);
  const side = loadSidecar(payloadPath);
  const added = [];
  const take = (ref, hit) => {
    if (!hit || side.bindings[ref]) return;
    side.bindings[ref] = { bead: hit.id, source: `auto@${(hit.containment ?? 0).toFixed(2)}` };
    added.push(ref);
  };
  for (const row of map.rows) take(row.ref, row.beads[0]);
  for (const f of map.frames) take(`${f.ref}#frame`, f.beads[0]);
  if (write && added.length) writeJsonAtomic(sidecarPath(payloadPath), side);
  return { sidecar: side, added };
}

/** One record per ref with a binding (plus text-bearing refs without one). */
export function itemsFor(payload, side, idx) {
  const out = [];
  const refs = new Set(Object.keys(side.bindings));
  for (const ref of ['summary']) refs.add(ref);
  (payload.experience || []).forEach((e, i) => (e.bullets || []).forEach((_, j) => refs.add(`experience[${i}].bullets[${j}]`)));
  for (const ref of refs) {
    const b = side.bindings[ref];
    const hit = b ? idx.get(b.bead) : null;
    const text = textAt(payload, ref);
    const beadText = hit ? (ref === 'summary' && hit.store === 'career' ? summaryTextOf(hit.bead.description) ?? hit.bead.description ?? '' : hit.bead.description ?? '') : null;
    // Only a résumé bullet bead holds paste-ready bullet text; a frame, project
    // or career bead describes something else even when its text is one line.
    const holdsText = hit && (hit.store === 'resume_bullets' || (ref === 'summary' && hit.store === 'career'));
    const pullable = !!(holdsText && text !== null && isPlainProse(beadText));
    out.push({
      ref,
      beadId: b?.bead ?? null,
      source: b?.source ?? null,
      missing: !!b && !hit,
      store: hit?.store ?? null,
      title: hit?.bead.title ?? '',
      status: hit ? hit.status : 'UNMAPPED',
      text,
      beadText,
      pullable,
      drift: pullable && normText(text) !== normText(beadText),
    });
  }
  return out;
}

/**
 * The payload as it reads when every pullable ref shows its bead's CURRENT
 * description. Pure: nothing is written. `changed` lists the refs whose text
 * the bead replaced, so a caller can say which wording came from a bead.
 */
export function resolvePayload(payload, side, idx) {
  const out = structuredClone(payload);
  const changed = [];
  for (const it of itemsFor(payload, side, idx)) {
    if (!it.pullable || !it.drift) continue;
    if (setTextAt(out, it.ref, normText(it.beadText))) changed.push(it.ref);
  }
  return { payload: out, changed };
}

/** Copy the bound bead's current description into the payload at `ref`. */
export function pullRef(payloadPath, ref) {
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const side = loadSidecar(payloadPath);
  const idx = beadIndex();
  const it = itemsFor(payload, side, idx).find((x) => x.ref === ref);
  if (!it) throw new Error(`no such ref: ${ref}`);
  if (!it.beadId) throw new Error(`${ref} has no bead bound`);
  if (it.missing) throw new Error(`${ref}: bead ${it.beadId} no longer exists`);
  if (!it.pullable) throw new Error(`${ref}: bead ${it.beadId} is not plain prose, or ${ref} is not a pullable text`);
  const next = normText(it.beadText);
  if (normText(it.text) === next) return { changed: false, ref, text: it.text };
  copyFileSync(payloadPath, `${payloadPath}.prev`);
  if (!setTextAt(payload, ref, next)) throw new Error(`cannot write ${ref}`);
  writeJsonAtomic(payloadPath, payload);
  return { changed: true, ref, text: next, previous: it.text };
}

function main(argv) {
  const [cmd, file, ref] = argv;
  if (!cmd || !file) {
    console.error('usage: node payload-beads.mjs <bind|status|pull> <payload.json> [ref]');
    return 2;
  }
  if (cmd === 'bind') {
    const { added, sidecar } = bindPayload(file);
    console.log(`${added.length} binding(s) added, ${Object.keys(sidecar.bindings).length} total → ${sidecarPath(file)}`);
    return 0;
  }
  if (cmd === 'status') {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const items = itemsFor(payload, loadSidecar(file), beadIndex());
    for (const it of items) {
      const flag = it.missing ? 'MISSING' : it.drift ? 'DRIFT' : it.beadId ? 'ok' : 'unbound';
      console.log(`${flag.padEnd(8)} ${it.status.padEnd(11)} ${it.ref.padEnd(34)} ${it.beadId ?? '-'} ${it.source ?? ''}`);
    }
    return 0;
  }
  if (cmd === 'pull' && ref) {
    const r = pullRef(file, ref);
    console.log(r.changed ? `pulled ${ref}\n  was: ${r.previous}\n  now: ${r.text}` : `${ref} already matches its bead`);
    return 0;
  }
  console.error('usage: node payload-beads.mjs <bind|status|pull> <payload.json> [ref]');
  return 2;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  }
}

/**
 * The header bead (YAML `header:` block) is the authority for the payload's candidate
 * block: name, headline and contacts. Returns a copy; the payload on disk is untouched.
 */
export function withHeaderBead(payload, bead) {
  let h;
  try { h = yaml.load(bead?.description ?? '')?.header; } catch { return payload; }
  if (!h || typeof h !== 'object') return payload;
  const c = { ...(payload.candidate ?? {}) };
  if (h.name) c.name = h.name;
  const title = Array.isArray(h.title) ? h.title.join(' · ') : h.title;
  if (title) c.title = title;
  for (const k of h.contacts ?? []) {
    if (k.kind === 'email') c.email = k.label;
    else if (k.kind === 'location') c.location = k.label;
    else if (['linkedin', 'github', 'portfolio'].includes(k.kind)) c[k.kind] = { url: k.url, display: k.label };
  }
  return { ...payload, candidate: c };
}

/**
 * A bead may be referenced once across a résumé: in the manifest's sections or
 * in a job's metadata.bullets. Returns [{bead, where: [..]}] for every bead
 * listed more than once (inside one list or across lists).
 * @param {{sections?: Record<string, {bead?: string}[]>}} manifest
 * @param {Record<string, string[]>} frameBullets job bead id -> its metadata.bullets ids
 */
export function findDuplicateBeads(manifest, frameBullets = {}) {
  const seen = new Map();
  const add = (bead, where) => { if (bead) seen.set(bead, [...(seen.get(bead) || []), where]); };
  for (const [name, entries] of Object.entries(manifest?.sections || {})) (entries || []).forEach((e) => add(e?.bead, `sections.${name}`));
  for (const [job, ids] of Object.entries(frameBullets)) (ids || []).forEach((id) => add(id, `${job}.metadata.bullets`));
  return [...seen].filter(([, w]) => w.length > 1).map(([bead, where]) => ({ bead, where }));
}
