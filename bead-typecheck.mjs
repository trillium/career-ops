#!/usr/bin/env node

/**
 * bead-typecheck.mjs — does a bead's text have the shape its ROLE requires?
 *
 * A bead's role comes from where the résumé uses it (manifest section or
 * sidecar ref), not from its label alone: a frame bead bound as a bullet is a
 * type error even though each is fine in its own place. The formats are the
 * ones written down in project-nuj9.10.
 *
 *   checkBead(role, bead) -> string[]   problems, empty = passes
 *   roleOfSection(name) / roleOfRef(ref)
 *
 * Failing beads stay in the tree with a red warning (bead-tree.mjs) and can
 * carry the label `does-not-pass-type-check`. Syncing that label (and a notes
 * line) never touches the description, so confirmation (a hash of the
 * description) is not disturbed.
 *
 * Usage:  node bead-typecheck.mjs <resume-id> [payload.json] [--sync]
 */

import * as yaml from 'js-yaml';

export const FAIL_LABEL = 'does-not-pass-type-check';
export const NOTE_MARK = 'TYPE CHECK:';
const CONTACT_KINDS = ['email', 'location', 'linkedin', 'github', 'portfolio'];
const FRAME_ROOTS = ['workExperience', 'openSource', 'projects', 'education'];

export function roleOfSection(name) {
  return ({
    header: 'header', careerSummary: 'summary', workExperience: 'frame', openSource: 'frame', projects: 'frame',
    education: 'education', skills: 'skill', awards: 'bullet', bullets: 'bullet', technical: 'section', coverLetter: 'coverLetter',
  })[name] ?? null;
}

export function roleOfRef(ref) {
  if (ref === 'summary') return 'summary';
  if (ref === 'candidate') return 'header';
  if (/#frame$/.test(ref)) return 'frame';
  if (/^education\[/.test(ref)) return 'education';
  if (/^skills\[/.test(ref)) return 'skill';
  if (/^(experience\[\d+\]\.bullets|awards)\[/.test(ref)) return 'bullet';
  return null;
}

const parse = (text) => {
  try { return { value: yaml.load(text) }; } catch (e) { return { error: String(e.message ?? e).split('\n')[0] }; }
};

export function checkBead(role, bead) {
  const text = bead?.description;
  if (typeof text !== 'string' || !text.trim()) return ['description is empty'];
  const looksStructured = /^\s*[\w.-]+:\s*$/m.test(text) || /^\s*-\s+[\w.-]+:/m.test(text) || /\bposition:/.test(text);

  if (role === 'bullet') {
    if (looksStructured) return ['bound as a bullet but its text is YAML/a frame; a bullet bead is one plain line of prose'];
    if (text.trim().split('\n').length > 3) return ['bullet text is more than 3 lines'];
    return [];
  }
  if (role === 'summary') {
    if (!/^\s*careerSummary:/.test(text)) return []; // plain prose is accepted
    const p = parse(text);
    if (p.error) return [`summary YAML does not parse: ${p.error}`];
    const items = p.value?.careerSummary;
    if (!Array.isArray(items)) return ['careerSummary: must be a list'];
    const exp = items.find((i) => i?.title === 'Experience');
    return exp && typeof exp.text === 'string' && exp.text.trim() ? [] : ['careerSummary has no item "title: Experience" with text'];
  }

  if (role === 'skill') {
    const sp = parse(text);
    if (sp.error) return [`skill YAML does not parse: ${sp.error}`];
    const o = sp.value;
    if (!o || typeof o !== 'object' || !o.category) return ['a skills line needs "category:" and a "bubbles:" list (YAML); this bead is a different kind'];
    return Array.isArray(o.bubbles) && o.bubbles.length ? [] : ['skills bead has no "bubbles:" list'];
  }
  const p = parse(text);
  if (p.error) return [`YAML does not parse: ${p.error}`];
  const v = p.value;
  if (!v || typeof v !== 'object') return ['expected a YAML mapping, got plain text'];

  if (role === 'header') {
    const h = v.header;
    if (!h || typeof h !== 'object') return ['missing top-level "header:" block'];
    const out = [];
    if (!h.name) out.push('header.name is missing');
    if (!(Array.isArray(h.title) ? h.title.length : h.title)) out.push('header.title is missing');
    if (!Array.isArray(h.contacts)) out.push('header.contacts must be a list');
    else h.contacts.forEach((c, i) => {
      if (!CONTACT_KINDS.includes(c?.kind)) out.push(`contacts[${i}].kind '${c?.kind}' not one of ${CONTACT_KINDS.join('/')}`);
      else if (!c.label) out.push(`contacts[${i}] (${c.kind}) has no label`);
      else if (['linkedin', 'github', 'portfolio'].includes(c.kind) && !c.url) out.push(`contacts[${i}] (${c.kind}) has no url`);
    });
    return out;
  }
  if (role === 'frame' || role === 'education') {
    const root = FRAME_ROOTS.find((k) => k in v);
    if (!root) return [`top-level key must be one of ${FRAME_ROOTS.join('/')}`];
    if (role === 'education' && root !== 'education') return ['education bead must start with "education:"'];
    if (role === 'frame' && root === 'education') return ['an education bead is bound as an experience/project frame'];
    if (!Array.isArray(v[root]) || !v[root].length) return [`${root}: must be a non-empty list`];
    const need = root === 'workExperience' || root === 'openSource' ? ['position', 'company'] : root === 'projects' ? ['name'] : ['school'];
    return v[root].flatMap((e, i) => need.filter((k) => !e?.[k]).map((k) => `${root}[${i}].${k} is missing`));
  }
  return [];
}

/** Manifest-level check: JSON parses, sections is an object, entries are consistent. */
export function checkManifest(bead) {
  let m;
  try { m = JSON.parse(bead?.description || ''); } catch (e) { return [`manifest is not valid JSON: ${String(e.message).split('\n')[0]}`]; }
  if (!m || typeof m.sections !== 'object' || Array.isArray(m.sections)) return ['manifest has no "sections" object'];
  const out = [];
  for (const [name, list] of Object.entries(m.sections)) {
    if (!Array.isArray(list)) { out.push(`sections.${name} must be a list`); continue; }
    list.forEach((e, i) => {
      if (!e?.ref) out.push(`sections.${name}[${i}] has no ref`);
      if (e?.resolved === true && !e.bead) out.push(`sections.${name}[${i}] (${e?.ref}) is resolved:true but names no bead`);
    });
  }
  return out;
}
