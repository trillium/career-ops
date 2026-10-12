#!/usr/bin/env node

/**
 * resume-data-to-payload.mjs — adapt resume-data.py JSON (the docx-oriented
 * shape) into the payload shape build-cv-html.mjs reads.
 *
 *   header.contacts[]  -> candidate{email,location,linkedin,github,portfolio}
 *   skills (string)    -> skills[{category, items[]}]
 *   experience[]       -> experience[{company, role, dates, location, bullets}]
 *   projects[]         -> projects[{name, description, bullets}]
 *   education[] (str)  -> education[{title, org, location, year}]
 *
 * Usage:  ~/.pyenv/shims/python3 local/resume-beads/resume-data.py <resume-id> \
 *           | node resume-data-to-payload.mjs > payload.json
 *         node resume-data-to-payload.mjs resume.json > payload.json
 */

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

/** Split on commas that are not inside parentheses. */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(s ?? '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function candidateOf(header = {}) {
  const c = { name: header.name ?? '', title: header.title ?? '' };
  for (const k of header.contacts ?? []) {
    const label = k.label ?? '', url = k.url ?? '';
    if (/^mailto:/.test(url) || /^[^@\s]+@[^@\s]+$/.test(label)) c.email = label;
    else if (/linkedin\.com/.test(url + label)) c.linkedin = { url, display: label };
    else if (/github\.com/.test(url + label)) c.github = { url, display: label };
    else if (/^https?:/.test(url) && !c.portfolio) c.portfolio = { url, display: label };
    else if (!url && !c.location) c.location = label;
  }
  return c;
}

function educationOf(line) {
  const [head = '', location = '', year = ''] = String(line).split(/\s*\|\s*/);
  const [title, ...org] = head.split(/\s+[—–-]\s+/);
  // "School — Credential": the school is the org, the credential the title.
  return { title: org.length ? org.join(' — ') : title, org: org.length ? title : '', location, year };
}

export function toPayload(d) {
  return {
    lang: 'en',
    candidate: candidateOf(d.header),
    summary: d.summary ?? '',
    skills: d.skills ? [{ category: 'Skills', items: splitTop(d.skills) }] : [],
    experience: (d.experience ?? []).map((e) => ({ company: e.org || e.title, role: e.title, dates: e.meta ?? '', location: '', bullets: e.bullets ?? [] })),
    projects: (d.projects ?? []).map((p) => ({ name: p.title, description: p.meta ?? '', bullets: p.bullets ?? [] })),
    education: (d.education ?? []).map(educationOf),
  };
}

if (isMainModule(import.meta.url)) {
  const file = process.argv[2];
  process.stdout.write(`${JSON.stringify(toPayload(JSON.parse(readFileSync(file || 0, 'utf8'))), null, 2)}\n`);
}
