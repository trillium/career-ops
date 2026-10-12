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
