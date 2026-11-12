#!/usr/bin/env node

/**
 * lavish-live.mjs — a live bead-review page for a tailored-CV payload.
 *
 * lavish-resume.mjs --payload writes a static page; once a bead is edited the
 * page is stale until someone rebuilds it. This keeps a small local server
 * beside the page so the page follows the beads while it stays open:
 *
 *   - the page polls GET /poll; the server re-reads every bead store and
 *     re-renders the payload, and answers 204 (nothing to do) or an htmx
 *     out-of-band bundle with every changed item, so a bead edited, confirmed
 *     or un-confirmed elsewhere repaints its chip in place;
 *   - the page SHOWS each bound bullet's (and the summary's) CURRENT bead
 *     description, not the payload's copy. The payload file is never written;
 *     resolvePayload() in payload-beads.mjs builds the in-memory view.
 *
 * Bead links come from the sidecar written by payload-beads.mjs, not from text
 * matching. A ref with no binding falls back to "no bead".
 *
 * The page is a Lavish artifact: it runs in an iframe sandboxed WITHOUT
 * allow-same-origin, so its origin is opaque and every call to this server is
 * cross-origin. The server therefore sends permissive CORS headers, and the
 * page sets htmx's selfRequestsOnly=false. Because that CORS policy lets any
 * web page reach the server, it binds 127.0.0.1 only and exposes GETs plus one token-guarded POST /toggle.
 *
 * Usage:  node lavish-live.mjs <payload.json> [--port=4391] [--out=.lavish] [--resume=<resume-bead-id>] [--no-open]
 *
 * --resume adds the descending bead tree (bead-tree.mjs) above the panel and
 * repaints it on /poll like every other tagged element.
 */

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { createServer } from 'http';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { GLYPH, PAYLOAD_CSS, norm, unescapeHtml } from './lavish-resume.mjs';
import { beadIndex, bindPayload, withManifestSummary, withManifestExperience, withManifestEmptySections, withManifestAwards, withFrameBullets, withFrameFields, findDuplicateBeads, frameBulletIds, withHeaderBead, itemsFor, loadSidecar, resolvePayload, sidecarPath } from './payload-beads.mjs';
import { loadCorpus, mapPayload, toggleConfirm } from './resume-beads.mjs';
import { STORES } from './payload-beads.mjs';
import { TREE_CSS, TREE_JS, buildTree, syncTypeLabels, typecheckResume, loadResumeBead, manifestSummaryBead, manifestExperienceBeads, renderTree } from './bead-tree.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HTMX_SRC = join(ROOT, 'lib', 'vendor', 'htmx-2.0.4.min.js');
const HTMX_NAME = 'htmx.min.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (ref) => ref.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

const LIVE_CSS = `
<style id="lavish-live">
  .lv-chip.DRIFT { color: #b26a00; }
  .lv-flash { animation: lvflash 1.4s ease-out; }
  @keyframes lvflash { from { background: #fff3b0; } to { background: transparent; } }
  .lv-live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #1a7f37; margin-right: 5px; }
  .lv-live-dot.off { background: #999; }
  [data-bead]:not(span) { position: relative; }
  /* Pills sit in the right margin, out of flow, so they never reflow the CV text. */
  /* The frame's pill holder is a flex item in the header; pin it to the header's right edge so its pills line up with the bullets'. */
  .job-header > span[data-bead] { position: absolute; right: 0; top: 0; width: 0; height: 0; }
  .lv-chip { position: absolute; left: 100%; top: 3px; margin: 0 0 0 36px; z-index: 1; }
  .lv-tog { position: absolute; right: -30px; top: 0; width: 22px; height: 22px; padding: 0; border: 1px solid #999; border-radius: 50%; background: #fff; font-size: 12px; line-height: 20px; cursor: pointer; opacity: .55; }
  .lv-tog:hover { opacity: 1; border-color: #333; }
  .lv-tog.CONFIRMED { border-color: #1a7f37; color: #1a7f37; }
  .lv-tog.htmx-request { opacity: .3; }
  @media print { .lv-live-dot, .lv-tog { display: none !important; } }
</style>`;

/** Build the CV HTML for the payload as it is on disk right now. */
function buildCvHtml(payloadPath) {
  const tmp = join(ROOT, '.lavish', '.live-render.html');
  mkdirSync(dirname(tmp), { recursive: true });
  const template = execFileSync('node', [join(ROOT, 'cv-templates.mjs'), 'resolve', 'cv'], { encoding: 'utf8' }).trim();
  execFileSync('node', [join(ROOT, 'build-cv-html.mjs'), payloadPath, tmp, template], { stdio: ['ignore', 'ignore', 'inherit'] });
  return readFileSync(tmp, 'utf8');
}

/** The résumé as the beads say it NOW, in render order: the payload and sidecar after every bead-owned transform. Pure apart from reading beads. */
export function resolveLive(payloadPath, resumeId = null) {
  const rawSide = loadSidecar(payloadPath);
  const idx = beadIndex();
  // The résumé bead is the authority: its manifest's careerSummary beats a frozen sidecar binding.
  const resumeBead = resumeId ? loadResumeBead(resumeId) : null;
  const summarised = resumeId ? withManifestSummary(rawSide, manifestSummaryBead(resumeBead), resumeId) : rawSide;
  // The page shows what the beads say NOW: bound bullets and the summary take
  // their bead's current description. The payload on disk is not touched.
  const diskPayload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  // ...and the résumé bead's manifest owns which jobs show and in what order.
  const ordered = resumeId ? withManifestExperience(diskPayload, summarised, manifestExperienceBeads(resumeBead)) : { payload: diskPayload, side: summarised, missing: [], dropped: [] };
  if (ordered.missing.length) console.warn(`⚠ manifest lists job bead(s) with no payload entry to render: ${ordered.missing.join(', ')}`);
  // Each job's frame bead owns the order of its bullets (metadata.bullets).
  if (resumeBead) {
    const frames = Object.fromEntries(manifestExperienceBeads(resumeBead).map((id) => [id, frameBulletIds(idx.get(id)?.bead) || []]));
    const dups = findDuplicateBeads(JSON.parse(resumeBead.description || '{}'), frames);
    for (const d of dups) console.warn(`⚠ DUPLICATE bead ${d.bead} listed ${d.where.length}x: ${d.where.join(', ')}`);
  }
  const pruned = resumeBead ? withManifestEmptySections(ordered.payload, ordered.side, JSON.parse(resumeBead.description || '{}').sections) : ordered;
  const awarded = resumeBead ? withManifestAwards(pruned.payload, pruned.side, JSON.parse(resumeBead.description || '{}').sections, idx) : { ...pruned, missing: [] };
  if (awarded.missing.length) console.warn(`⚠ manifest awards list bead(s) that cannot be read: ${awarded.missing.join(', ')}`);
  const withBullets = withFrameBullets(awarded.payload, awarded.side, idx);
  if (withBullets.missing.length) console.warn(`⚠ a job bead lists bullet bead(s) with no payload bullet to render: ${withBullets.missing.join(', ')}`);
  const rawPayload = withFrameFields(withBullets.payload, withBullets.side, idx);
  const side = withBullets.side;
  const headerBead = side.bindings.candidate?.bead ? idx.get(side.bindings.candidate.bead)?.bead : null;
  const { payload, changed } = resolvePayload(headerBead ? withHeaderBead(rawPayload, headerBead) : rawPayload, side, idx);
  return { payload, side, idx, changed, rawSide, resumeBead };
}

/**
 * One full render. Returns the page html plus every tagged element as
 * { id, html } so /poll can resend exactly those elements out of band.
 */
export function renderLive(payloadPath, { server, token, resumeId = null }) {
  const { payload, side, idx, changed, rawSide, resumeBead } = resolveLive(payloadPath, resumeId);
  const fromBead = new Set(changed);
  const resolvedPath = join(ROOT, '.lavish', '.live-payload.json');
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, JSON.stringify(payload, null, 2));
  let html = buildCvHtml(resolvedPath);
  const { corpus } = loadCorpus(STORES);
  const map = mapPayload(payload, corpus);
  const itemByRef = new Map(itemsFor(payload, side, idx).map((i) => [i.ref, i]));
  const refByText = new Map(map.rows.map((r) => [norm(r.text), r.ref]));

  const elements = [];
  let anon = 0;
  const statusOf = (beadId) => (beadId && idx.has(beadId) ? idx.get(beadId).status : 'UNMAPPED');

  const chip = (beadId, source, it) => {
    if (!beadId) return '<code class="lv-chip UNMAPPED" title="no bead is bound to this text">no bead</code>';
    const st = statusOf(beadId);
    const meta = idx.get(beadId);
    const note = it && fromBead.has(it.ref) ? ' — text taken from the bead' : '';
    return `<code class="lv-chip ${st}" title="${esc(meta?.bead.title ?? 'bead not found')} — ${esc(source ?? '')}${note}">${GLYPH[st] ?? ''} ${esc(beadId)}</code>${toggle(beadId, st)}`;
  };
  // Click to flip the bead's confirmation. Confirms the BEAD's text, which is
  // what the line shows unless it is flagged as reworded.
  const toggle = (beadId, st) => `<button type="button" class="lv-tog ${st}" hx-post="${server}/toggle?bead=${encodeURIComponent(beadId)}" hx-swap="none" title="${st === 'CONFIRMED' ? 'Confirmed — click to un-confirm' : 'Not confirmed — click to confirm this bead\'s current text'}">${st === 'CONFIRMED' ? '✓' : '○'}</button>`;

  const wrap = (tag, cls, inner, ref, beadId, source) => {
    const it = ref ? itemByRef.get(ref) : null;
    const id = `it-${ref ? slug(ref) : `x${anon++}`}`;
    const st = statusOf(beadId);
    const attrs = beadId
      ? `data-bead="${esc(beadId)}" data-store="${esc(idx.get(beadId)?.store ?? '')}" data-status="${esc(st)}"`
      : 'data-bead="" data-status="UNMAPPED"';
    const open = `<${tag} id="${id}"${cls ? ` class="${cls}"` : ''} data-ref="${esc(ref ?? '')}" ${attrs}>`;
    let chipHtml = chip(beadId, source, it);
    // The header bead is tagged on three lines; one button (on the name) is enough.
    if (ref === 'candidate.title' || ref === 'candidate.contacts') chipHtml = chipHtml.replace(/<button[\s\S]*?<\/button>/, '');
    const outer = `${open}${inner}${chipHtml}</${tag}>`;
    elements.push({ id, html: outer });
    return outer;
  };
  const boundFor = (ref) => {
    const b = ref ? side.bindings[ref] : null;
    return { beadId: b?.bead ?? null, source: b?.source ?? null };
  };
  const refFor = (inner) => refByText.get(norm(inner)) ?? null;

  html = html.replace(/<li>([\s\S]*?)<\/li>/g, (m, inner) => {
    const ref = refFor(inner);
    const { beadId, source } = boundFor(ref);
    return wrap('li', '', inner, ref, beadId, source);
  });
  // Education and Leadership entries nest divs, so find each block by depth, not by the first </div>.
  const wrapBlocks = (cls, refOf) => {
    const open = `<div class="${cls}">`;
    let out = '';
    let pos = 0;
    let n = 0;
    for (;;) {
      const at = html.indexOf(open, pos);
      if (at < 0) break;
      let depth = 1;
      let i = at + open.length;
      while (depth > 0) {
        const o = html.indexOf('<div', i);
        const c = html.indexOf('</div>', i);
        if (c < 0) throw new Error(`unbalanced <div class="${cls}">`);
        if (o >= 0 && o < c) { depth += 1; i = o + 4; } else { depth -= 1; i = c + 6; }
      }
      const ref = refOf(n++);
      const { beadId, source } = boundFor(ref);
      out += html.slice(pos, at) + wrap('div', cls, html.slice(at + open.length, i - 6), ref, beadId, source);
      pos = i;
    }
    html = out + html.slice(pos);
  };
  wrapBlocks('edu-item', (n) => `education[${n}]`);
  wrapBlocks('award-item', (n) => `awards[${n}]`);
  // Header block: the name line carries the candidate (name, headline, contacts) bead.
  html = html.replace(/<div class="header-title">([\s\S]*?)<\/div>/, (m, inner) => {
    const { beadId, source } = boundFor('candidate');
    return wrap('div', 'header-title', inner, 'candidate.title', beadId, source);
  });
  html = html.replace(/<div class="contact-row">([\s\S]*?)<\/div>/, (m, inner) => {
    const { beadId, source } = boundFor('candidate');
    return wrap('div', 'contact-row', inner, 'candidate.contacts', beadId, source);
  });
  html = html.replace(/<h1>([\s\S]*?)<\/h1>/, (m, inner) => {
    const { beadId, source } = boundFor('candidate');
    return wrap('h1', '', inner, 'candidate', beadId, source);
  });
  html = html.replace(/<div class="summary-text">([\s\S]*?)<\/div>/g, (m, inner) => {
    const { beadId, source } = boundFor('summary');
    return wrap('div', 'summary-text', inner, 'summary', beadId, source);
  });
  html = html.replace(/<div class="skill-item">([\s\S]*?)<\/div>/g, (m, inner) => {
    const ref = refFor(inner);
    const { beadId, source } = boundFor(ref);
    return wrap('div', 'skill-item', inner, ref, beadId, source);
  });
  // Role headers: the frame bead for experience[i].
  let roleIdx = -1;
  html = html.replace(/<div class="job-header">\s*<span class="job-company">([\s\S]*?)<\/span>/g, (m, company) => {
    roleIdx += 1;
    const ref = `experience[${roleIdx}]#frame`;
    const { beadId, source } = boundFor(ref);
    const id = `it-${slug(ref)}`;
    const st = statusOf(beadId);
    const attrs = beadId ? `data-bead="${esc(beadId)}" data-status="${esc(st)}"` : 'data-bead="" data-status="UNMAPPED"';
    const note = unescapeHtml(company);
    elements.push({ id, html: `<span id="${id}" data-ref="${esc(ref)}" ${attrs}>${chip(beadId, source, null)}</span>` });
    return `<div class="job-header" ${attrs}><span class="job-company">${company}</span><span id="${id}" data-ref="${esc(ref)}" ${attrs} title="${esc(note)}">${chip(beadId, source, null)}</span>`;
  });

  // Descending bead tree: résumé bead on top, manifest edges plus sidecar edges.
  let treeHtml = '';
  if (resumeId) {
    const tree = buildTree(resumeId, idx, rawSide, resumeBead);
    try { syncTypeLabels(tree, idx); } catch { /* labels are advisory; the on-page warning stays */ }
    treeHtml = renderTree(tree);
    elements.push({ id: 'lv-tree', html: treeHtml });
  }

  const tally = { CONFIRMED: 0, STALE: 0, UNCONFIRMED: 0, UNMAPPED: 0 };
  const drift = fromBead.size;
  for (const it of itemByRef.values()) {
    tally[it.status] += 1;
  }
  const panel = (oob) => `<div id="lv-panel" class="lv-panel"${oob ? ' hx-swap-oob="outerHTML"' : ''}>
<h4><span class="lv-live-dot"></span>Bead review — ${esc(basename(payloadPath))}</h4>
<div>✅ ${tally.CONFIRMED} · ❌ ${tally.UNCONFIRMED + tally.STALE} · no bead ${tally.UNMAPPED}${drift ? ` · ${drift} lines worded by their bead` : ''}</div>
<p>Live: this page shows each bead's current text. Edit or confirm a bead and the line repaints within a few seconds. The payload file is not changed.</p>
<p style="color:#666">Updated ${new Date().toLocaleTimeString()}</p></div>`;

  const version = createHash('sha1').update(elements.map((e) => e.html).join('\n')).digest('hex').slice(0, 12);
  // Which tagged elements exist, in order: when this changes (a bullet added, removed or moved) text repainting is not enough and the page reloads.
  // Also the page text outside those elements (role, company, descriptor, dates), which repainting cannot reach.
  const shell = elements.reduce((h, e) => h.split(e.html).join(''), html);
  const struct = createHash('sha1').update(`${elements.map((e) => e.id).join('|')}\n${shell}`).digest('hex').slice(0, 12);
  const poller = (oob) => `<div id="lv-poll" hx-get="${server}/poll?v=${version}&s=${struct}" hx-trigger="every 4s" hx-swap="none"${oob ? ' hx-swap-oob="outerHTML"' : ''} style="display:none"></div>`;

  const head = `<meta name="htmx-config" content='{"selfRequestsOnly":false,"allowEval":false}'>
<script src="${HTMX_NAME}"></script>${PAYLOAD_CSS}${LIVE_CSS}${resumeId ? TREE_CSS : ''}`;
  html = html
    .replace('</head>', `${head}</head>`)
    .replace(/<body([^>]*)>/, `<body$1 hx-headers='${esc(JSON.stringify({ 'X-Lavish-Token': token }))}'>`)
    .replace('</body>', `${treeHtml}${poller(false)}${resumeId ? TREE_JS : ''}</body>`);

  const oob = () => `${elements.map((e) => e.html.replace(/^<(\w+)/, '<$1 hx-swap-oob="outerHTML"')).join('\n')}\n${poller(true)}`;
  return { html, version, struct, oob, tally, drift };
}

/**
 * Everything derived from the beads, kept current without anyone running a command:
 * type-check labels on failing beads, the payload + sidecar on disk, the export bead an
 * MCP-only reader uses, and the Lavish copy of the page. Idempotent: writes only on a diff.
 */
export function settle(payloadPath, { resumeId, exportBead = null, lavishCopy = null, token = '' }) {
  const did = [];
  const tc = typecheckResume(resumeId, payloadPath);
  if (tc.synced?.labelled.length || tc.synced?.cleared.length) did.push(`type labels +${tc.synced.labelled.length}/-${tc.synced.cleared.length}`);
  const { payload, side } = resolveLive(payloadPath, resumeId);
  const pj = `${JSON.stringify(payload, null, 2)}\n`;
  const sp = sidecarPath(payloadPath);
  const sj = `${JSON.stringify({ version: 1, bindings: side.bindings }, null, 2)}\n`;
  if (readFileSync(payloadPath, 'utf8') !== pj) { copyFileSync(payloadPath, `${payloadPath}.bak`); writeFileSync(payloadPath, pj); did.push('payload'); }
  if (!existsSync(sp) || readFileSync(sp, 'utf8') !== sj) { if (existsSync(sp)) copyFileSync(sp, `${sp}.bak`); writeFileSync(sp, sj); did.push('sidecar'); }
  if (exportBead) {
    const store = exportBead.replace(/-[^-]+$/, '');
    const cur = JSON.parse(execFileSync(join(homedir(), '.local', 'bin', store), ['show', exportBead, '--json'], { encoding: 'utf8' }));
    if ((Array.isArray(cur) ? cur[0] : cur).description !== pj.trim() && (Array.isArray(cur) ? cur[0] : cur).description !== pj) {
      execFileSync(join(homedir(), '.local', 'bin', store), ['update', exportBead, '--description', pj], { encoding: 'utf8' });
      did.push(`export ${exportBead}`);
    }
  }
  if (lavishCopy) writeFileSync(lavishCopy.path, renderLive(payloadPath, { server: lavishCopy.server, token, resumeId }).html);
  return did;
}

function startServer(payloadPath, { port, token, resumeId, host = '127.0.0.1', base = null, lavishCopy = null, exportBead = null }) {
  const server = base ?? `http://127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${port}`;
  let busy = null;
  const render = () => renderLive(payloadPath, { server, token, resumeId });

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Lavish-Token, Content-Type, HX-Request, HX-Target, HX-Current-URL, HX-Trigger, HX-Trigger-Name, HX-Boosted, HX-Prompt',
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'HX-Refresh',
  };
  const send = (res, code, body, type = 'text/html; charset=utf-8', extra = {}) => {
    res.writeHead(code, { ...cors, 'Content-Type': type, ...extra });
    res.end(body);
  };
  const readBody = (req) => new Promise((ok) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => ok(b));
  });

  // No agent in the loop: whenever the beads change what the page shows, settle everything derived from them.
  let lastSeen = '';
  let settling = false;
  const watch = async () => {
    if (settling || busy) return;
    settling = true;
    try {
      const r = render();
      const key = `${r.version}:${r.struct}`;
      if (key !== lastSeen) {
        // Record what we saw BEFORE settling: an edit made mid-settle must trigger another pass.
        lastSeen = key;
        const did = settle(payloadPath, { resumeId, exportBead, lavishCopy, token });
        if (did.length) console.log(`↻ settled: ${did.join(', ')}`);
      }
    } catch (e) { console.error(`✗ settle: ${e.message}`); } finally { settling = false; }
  };
  if (resumeId) { setTimeout(watch, 1000); setInterval(watch, 5000).unref?.(); }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'GET' && url.pathname === '/poll') {
        // Serialise renders: a slow store read must not stack up behind the timer.
        if (busy) return send(res, 204, '');
        busy = Promise.resolve().then(render);
        const r = await busy.finally(() => { busy = null; });
        if (r.version === url.searchParams.get('v')) return send(res, 204, '');
        const s = url.searchParams.get('s');
        if (s && s !== r.struct) {
          // Structure changed: refresh the Lavish copy on disk, then have the page reload itself.
          if (lavishCopy) writeFileSync(lavishCopy.path, renderLive(payloadPath, { server: lavishCopy.server, token, resumeId }).html);
          return send(res, 200, '', 'text/html; charset=utf-8', { 'HX-Refresh': 'true' });
        }
        return send(res, 200, r.oob());
      }
      if (req.method === 'POST' && url.pathname === '/toggle') {
        if (req.headers['x-lavish-token'] !== token) return send(res, 403, 'bad token', 'text/plain');
        if (busy) await busy.catch(() => {});
        const entry = beadIndex().get(url.searchParams.get('bead') ?? '');
        if (!entry) return send(res, 404, 'unknown bead', 'text/plain');
        const now = toggleConfirm(entry.store, entry.bead);
        console.log(`${now === 'CONFIRMED' ? '✅ confirmed' : '❌ un-confirmed'} ${entry.bead.id} (by click)`);
        return send(res, 200, render().oob());
      }
      // The résumé itself lives at the server root, so a persistent instance is just a URL.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (busy) await busy.catch(() => {});
        return send(res, 200, render().html);
      }
      if (req.method === 'GET' && url.pathname === `/${HTMX_NAME}`) return send(res, 200, readFileSync(HTMX_SRC), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      console.error(`✗ ${req.method} ${req.url}: ${e.message}`);
      return send(res, 500, esc(e.message), 'text/plain');
    }
  }).listen(port, host);
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node lavish-live.mjs <payload.json> [--port=4391] [--out=.lavish] [--resume=<id>] [--host=127.0.0.1] [--base=] [--export-bead=<id>] [--no-open]');
    return 2;
  }
  const payloadPath = resolve(file);
  const port = Number((argv.find((a) => a.startsWith('--port=')) || '--port=4391').slice(7));
  const outDir = resolve((argv.find((a) => a.startsWith('--out=')) || '--out=.lavish').slice(6));
  const host = (argv.find((a) => a.startsWith('--host=')) || '--host=127.0.0.1').slice(7);
  // --base= '' makes the page use relative URLs, so it works at whatever address serves it.
  const baseArg = argv.find((a) => a.startsWith('--base='));
  const base = baseArg ? baseArg.slice(7) : null;
  const resumeId = (argv.find((a) => a.startsWith('--resume=')) || '').slice(9) || null;
  const token = randomBytes(16).toString('hex');

  if (!Object.keys(loadSidecar(payloadPath).bindings).length) {
    const { added } = bindPayload(payloadPath);
    console.log(`no bindings yet — created ${added.length} (see ${sidecarPath(payloadPath)})`);
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(HTMX_SRC, join(outDir, HTMX_NAME));
  const htmlPath = join(outDir, `${basename(payloadPath, '.json')}.live.html`);
  const first = renderLive(payloadPath, { server: `http://${host}:${port}`, token, resumeId }); // the Lavish copy lives on another origin, so it needs an absolute URL
  writeFileSync(htmlPath, first.html);

  const srv = startServer(payloadPath, { port, token, resumeId, host, base, lavishCopy: { path: htmlPath, server: `http://${host}:${port}` }, exportBead: (argv.find((a) => a.startsWith('--export-bead=')) || '').slice(14) || null });
  await new Promise((ok, fail) => { srv.once('listening', ok); srv.once('error', fail); });
  console.log(`✓ ${htmlPath}\n✓ live server http://${host}:${port} (poll /poll)`);
  console.log(`✅ ${first.tally.CONFIRMED} · ❌ ${first.tally.UNCONFIRMED + first.tally.STALE} · no bead ${first.tally.UNMAPPED} · ${first.drift} lines worded by their bead`);
  if (!argv.includes('--no-open')) execFileSync('lavish-axi', [htmlPath], { stdio: 'inherit' });
  else console.log(`Open it:  lavish-axi ${htmlPath}`);
  return new Promise(() => {}); // serve until killed
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { if (c) process.exitCode = c; }).catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  });
}
