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
 * web page reach the server, it binds 127.0.0.1 only and exposes read-only GETs.
 *
 * Usage:  node lavish-live.mjs <payload.json> [--port=4391] [--out=.lavish] [--resume=<resume-bead-id>] [--no-open]
 *
 * --resume adds the descending bead tree (bead-tree.mjs) above the panel and
 * repaints it on /poll like every other tagged element.
 */

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { GLYPH, PAYLOAD_CSS, norm, unescapeHtml } from './lavish-resume.mjs';
import { beadIndex, bindPayload, withManifestSummary, withHeaderBead, itemsFor, loadSidecar, resolvePayload, sidecarPath } from './payload-beads.mjs';
import { loadCorpus, mapPayload } from './resume-beads.mjs';
import { STORES } from './payload-beads.mjs';
import { TREE_CSS, TREE_JS, buildTree, syncTypeLabels, loadResumeBead, manifestSummaryBead, renderTree } from './bead-tree.mjs';

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
  @media print { .lv-live-dot { display: none !important; } }
</style>`;

/** Build the CV HTML for the payload as it is on disk right now. */
function buildCvHtml(payloadPath) {
  const tmp = join(ROOT, '.lavish', '.live-render.html');
  mkdirSync(dirname(tmp), { recursive: true });
  const template = execFileSync('node', [join(ROOT, 'cv-templates.mjs'), 'resolve', 'cv'], { encoding: 'utf8' }).trim();
  execFileSync('node', [join(ROOT, 'build-cv-html.mjs'), payloadPath, tmp, template], { stdio: ['ignore', 'ignore', 'inherit'] });
  return readFileSync(tmp, 'utf8');
}

/**
 * One full render. Returns the page html plus every tagged element as
 * { id, html } so /poll can resend exactly those elements out of band.
 */
export function renderLive(payloadPath, { server, token, resumeId = null }) {
  const rawSide = loadSidecar(payloadPath);
  const idx = beadIndex();
  // The résumé bead is the authority: its manifest's careerSummary beats a frozen sidecar binding.
  const resumeBead = resumeId ? loadResumeBead(resumeId) : null;
  const side = resumeId ? withManifestSummary(rawSide, manifestSummaryBead(resumeBead), resumeId) : rawSide;
  // The page shows what the beads say NOW: bound bullets and the summary take
  // their bead's current description. The payload on disk is not touched.
  const rawPayload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const headerBead = side.bindings.candidate?.bead ? idx.get(side.bindings.candidate.bead)?.bead : null;
  const { payload, changed } = resolvePayload(headerBead ? withHeaderBead(rawPayload, headerBead) : rawPayload, side, idx);
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
    return `<code class="lv-chip ${st}" title="${esc(meta?.bead.title ?? 'bead not found')} — ${esc(source ?? '')}${note}">${GLYPH[st] ?? ''} ${esc(beadId)}</code>`;
  };

  const wrap = (tag, cls, inner, ref, beadId, source) => {
    const it = ref ? itemByRef.get(ref) : null;
    const id = `it-${ref ? slug(ref) : `x${anon++}`}`;
    const st = statusOf(beadId);
    const attrs = beadId
      ? `data-bead="${esc(beadId)}" data-store="${esc(idx.get(beadId)?.store ?? '')}" data-status="${esc(st)}"`
      : 'data-bead="" data-status="UNMAPPED"';
    const open = `<${tag} id="${id}"${cls ? ` class="${cls}"` : ''} data-ref="${esc(ref ?? '')}" ${attrs}>`;
    const outer = `${open}${inner}${chip(beadId, source, it)}</${tag}>`;
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
  const poller = (oob) => `<div id="lv-poll" hx-get="${server}/poll?v=${version}" hx-trigger="every 4s" hx-swap="none"${oob ? ' hx-swap-oob="outerHTML"' : ''} style="display:none"></div>`;

  const head = `<meta name="htmx-config" content='{"selfRequestsOnly":false,"allowEval":false}'>
<script src="${HTMX_NAME}"></script>${PAYLOAD_CSS}${LIVE_CSS}${resumeId ? TREE_CSS : ''}`;
  html = html
    .replace('</head>', `${head}</head>`)
    .replace(/<body([^>]*)>/, `<body$1 hx-headers='${esc(JSON.stringify({ 'X-Lavish-Token': token }))}'>`)
    .replace('</body>', `${treeHtml}${poller(false)}${resumeId ? TREE_JS : ''}</body>`);

  const oob = () => `${elements.map((e) => e.html.replace(/^<(\w+)/, '<$1 hx-swap-oob="outerHTML"')).join('\n')}\n${poller(true)}`;
  return { html, version, oob, tally, drift };
}

function startServer(payloadPath, { port, token, resumeId }) {
  const server = `http://127.0.0.1:${port}`;
  let busy = null;
  const render = () => renderLive(payloadPath, { server, token, resumeId });

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Lavish-Token, Content-Type, HX-Request, HX-Target, HX-Current-URL, HX-Trigger, HX-Trigger-Name, HX-Boosted, HX-Prompt',
    'Cache-Control': 'no-store',
  };
  const send = (res, code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { ...cors, 'Content-Type': type });
    res.end(body);
  };
  const readBody = (req) => new Promise((ok) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => ok(b));
  });

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, server);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'GET' && url.pathname === '/poll') {
        // Serialise renders: a slow store read must not stack up behind the timer.
        if (busy) return send(res, 204, '');
        busy = Promise.resolve().then(render);
        const r = await busy.finally(() => { busy = null; });
        return r.version === url.searchParams.get('v') ? send(res, 204, '') : send(res, 200, r.oob());
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      console.error(`✗ ${req.method} ${req.url}: ${e.message}`);
      return send(res, 500, esc(e.message), 'text/plain');
    }
  }).listen(port, '127.0.0.1');
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node lavish-live.mjs <payload.json> [--port=4391] [--out=.lavish] [--resume=<id>] [--no-open]');
    return 2;
  }
  const payloadPath = resolve(file);
  const port = Number((argv.find((a) => a.startsWith('--port=')) || '--port=4391').slice(7));
  const outDir = resolve((argv.find((a) => a.startsWith('--out=')) || '--out=.lavish').slice(6));
  const resumeId = (argv.find((a) => a.startsWith('--resume=')) || '').slice(9) || null;
  const token = randomBytes(16).toString('hex');

  if (!Object.keys(loadSidecar(payloadPath).bindings).length) {
    const { added } = bindPayload(payloadPath);
    console.log(`no bindings yet — created ${added.length} (see ${sidecarPath(payloadPath)})`);
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(HTMX_SRC, join(outDir, HTMX_NAME));
  const htmlPath = join(outDir, `${basename(payloadPath, '.json')}.live.html`);
  const first = renderLive(payloadPath, { server: `http://127.0.0.1:${port}`, token, resumeId });
  writeFileSync(htmlPath, first.html);

  const srv = startServer(payloadPath, { port, token, resumeId });
  await new Promise((ok, fail) => { srv.once('listening', ok); srv.once('error', fail); });
  console.log(`✓ ${htmlPath}\n✓ live server http://127.0.0.1:${port} (poll /poll)`);
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
