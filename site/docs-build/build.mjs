// SPDX-License-Identifier: MIT
// Makes vennir.io/docs/<guide> from the repository's Markdown (make
// site-docs, and Firebase's predeploy): a page per guide in guides.json, the
// search page and its index, and the files they need, all under
// public/docs/, which git ignores. It changes no file git tracks: it checks
// that the Docs page's cards, sitemap.xml and llms.txt list every guide, and
// that no page links to a guide's file on GitHub instead of its page, and
// fails until they do.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
const repo = join(site, "..");
const pub = join(site, "public");
const out = join(pub, "docs");
const GITHUB = "https://github.com/roburns/vennir";
const SITE = "https://vennir.io";

const problems = [];
const read = (path) => readFileSync(path, "utf-8");

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescapeHtml(text) {
  return text.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// The guides, in the Docs page's order.
const manifest = JSON.parse(read(join(here, "guides.json")));
const guides = [];
for (const group of manifest.groups) {
  for (const guide of group.guides) guides.push({ ...guide, group });
}
const bySource = new Map(guides.map((g) => [g.source, g]));

// The Docs page: its header, footer and styles are every docs page's, and
// its cards must be the guides, in order, each linking to its page.
const docsPage = read(join(pub, "docs.html"));
function between(text, start, end) {
  const i = text.indexOf(start);
  const j = text.indexOf(end, i);
  if (i === -1 || j === -1) throw new Error(`docs.html: no ${start} … ${end}`);
  return text.slice(i, j + end.length);
}
const header = between(docsPage, "<!-- Nav -->", "</header>");
const footer = between(docsPage, "<!-- Footer -->", "</footer>");
const siteStyle = between(docsPage, "<style>", "</style>").slice("<style>".length, -"</style>".length);

const cards = [...docsPage.matchAll(/<li data-doc[^>]*>\s*<a href="([^"]+)"[\s\S]*?line-height: 1\.35; color: #FFFFFF">([^<]+)<\/span>\s*<span[^>]*>([^<]*)<\/span>/g)]
  .map(([, href, title, summary]) => ({ href, title, summary }));
cards.forEach((card, i) => {
  const guide = guides[i];
  if (!guide) problems.push(`docs.html: a card for ${card.href}, which isn't in guides.json`);
  else if (card.href !== `/docs/${guide.slug}`) problems.push(`docs.html: card ${i + 1} links to ${card.href}; guides.json's guide ${i + 1} is /docs/${guide.slug} (${guide.source})`);
  else Object.assign(guide, { title: card.title, summary: card.summary });
});
for (const guide of guides.slice(cards.length)) problems.push(`docs.html: no card for /docs/${guide.slug} (${guide.source})`);

// No page links to a guide's file on GitHub when the guide has a page here.
for (const name of readdirSync(pub).filter((n) => n.endsWith(".html"))) {
  for (const [, path] of read(join(pub, name)).matchAll(/https:\/\/github\.com\/roburns\/vennir\/blob\/main\/([^"#)\s]+)/g)) {
    const guide = bySource.get(path);
    if (guide) problems.push(`${name}: links to ${path} on GitHub; link to /docs/${guide.slug}`);
  }
}

// sitemap.xml and llms.txt list every guide's page.
const sitemap = read(join(pub, "sitemap.xml"));
const llms = read(join(pub, "llms.txt"));
for (const guide of guides) {
  const url = `${SITE}/docs/${guide.slug}`;
  if (!sitemap.includes(`<loc>${url}</loc>`)) problems.push(`sitemap.xml: no ${url}`);
  if (!llms.includes(`(${url})`)) problems.push(`llms.txt: no ${url}`);
}

// The released version, as the home page says it (each release changes it).
const version = /"softwareVersion":\s*"([^"]+)"/.exec(read(join(pub, "index.html")))?.[1];
if (!version) problems.push("index.html: no softwareVersion");

// Guides an install's Docs page serves too: its own guides, and the
// platform docs it ships a copy of (console/docs/reference/SOURCES).
const referenceCopies = new Map(
  read(join(repo, "console/docs/reference/SOURCES")).split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => { const [id, , path] = line.trim().split(/\s+/); return [id, path]; }),
);
const consoleServed = new Set(referenceCopies.values());
const servedByConsole = (source) => source.startsWith("console/docs/") || consoleServed.has(source);

// The console's guides name the platform docs by the id of the copy it
// serves (setup.md, clouds-gcp.md), and its API reference, which it makes
// from the protos, as api-reference.md.
function consoleTarget(target) {
  const name = posix.basename(target, ".md");
  if (posix.dirname(target) !== "console/docs") return null;
  if (referenceCopies.has(name)) return referenceCopies.get(name);
  if (name === "api-reference") return "proto/vennir/console/v1";
  return null;
}

// A link in a guide: to another guide's page, to the file or folder on
// GitHub, or as written when it leaves the repository.
function rewriteLink(href, source) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return href;
  const at = href.indexOf("#");
  const path = decodeURI(at === -1 ? href : href.slice(0, at));
  const hash = at === -1 ? "" : href.slice(at);
  if (!path) return href;
  let target = path.startsWith("/") ? path.slice(1) : posix.normalize(posix.join(posix.dirname(source), path));
  target = target.replace(/\/$/, "");
  if (!existsSync(join(repo, target))) target = consoleTarget(target) ?? target;
  if (target.startsWith("..")) {
    problems.push(`${source}: links to ${href}, outside the repository`);
    return href;
  }
  const guide = bySource.get(target) ?? bySource.get(`${target}/README.md`);
  if (guide) return `/docs/${guide.slug}${hash}`;
  if (!existsSync(join(repo, target))) {
    problems.push(`${source}: links to ${href}, which doesn't exist`);
    return `${GITHUB}/blob/main/${encodeURI(target)}${hash}`;
  }
  const kind = statSync(join(repo, target)).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${encodeURI(target)}${hash}`;
}

// An image in a guide is served from here (the site's CSP allows no other).
function rewriteImage(src, source) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
    problems.push(`${source}: an image from ${src}; the site serves only its own`);
    return src;
  }
  const target = posix.normalize(posix.join(posix.dirname(source), decodeURI(src)));
  if (!existsSync(join(repo, target))) {
    problems.push(`${source}: an image ${src}, which doesn't exist`);
    return src;
  }
  mkdirSync(dirname(join(out, "assets", target)), { recursive: true });
  copyFileSync(join(repo, target), join(out, "assets", target));
  return `/docs/assets/${encodeURI(target)}`;
}

// No raw HTML from the Markdown: what it writes is text, never markup.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  if (token.info.trim() === "mermaid") return `<pre class="mermaid">${esc(token.content)}</pre>\n`;
  return `<pre class="code" tabindex="0"><code>${esc(token.content)}</code></pre>\n`;
};
md.renderer.rules.code_block = (tokens, idx) => `<pre class="code" tabindex="0"><code>${esc(tokens[idx].content)}</code></pre>\n`;
md.renderer.rules.table_open = () => '<div class="tbl" tabindex="0"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";
md.renderer.rules.heading_close = (tokens, idx) => {
  const open = tokens[idx - 2];
  const id = open.attrGet("id");
  const anchor = (open.tag === "h2" || open.tag === "h3") && id ? `<a class="anchor" href="#${esc(id)}" aria-label="Link to this section">#</a>` : "";
  return `${anchor}</${open.tag}>\n`;
};

function inlineText(token) {
  return (token.children ?? []).map((child) => {
    if (child.type === "text" || child.type === "code_inline") return child.content;
    if (child.type === "softbreak" || child.type === "hardbreak") return " ";
    return "";
  }).join("");
}

// One guide: its title, its body, its sections, and its text for search.
function render(guide) {
  const tokens = md.parse(read(join(repo, guide.source)), {});
  const slugger = new GithubSlugger();
  let title = null;
  const toc = [];
  const sections = [];
  let section = { heading: "", anchor: "", text: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      const text = inlineText(tokens[i + 1]);
      if (token.tag === "h1" && title === null && toc.length === 0 && section.text.length === 0) {
        title = text;
        tokens.splice(i, 3);
        i--;
        continue;
      }
      const id = slugger.slug(text);
      token.attrSet("id", id);
      if (token.tag === "h2" || token.tag === "h3") {
        toc.push({ level: token.tag, text, id });
        sections.push(section);
        section = { heading: text, anchor: id, text: [] };
      }
      continue;
    }
    if (token.type === "inline") {
      for (const child of token.children ?? []) {
        if (child.type === "link_open") child.attrSet("href", rewriteLink(child.attrGet("href"), guide.source));
        if (child.type === "image") child.attrSet("src", rewriteImage(child.attrGet("src"), guide.source));
      }
      if (tokens[i - 1]?.type !== "heading_open") section.text.push(inlineText(token));
    }
    if (token.type === "fence" || token.type === "code_block") section.text.push(token.content);
  }
  sections.push(section);
  const body = md.renderer.render(tokens, md.options, {});
  return {
    // The card's title (HTML already) when the guide has no heading of its own.
    title: title ?? unescapeHtml(guide.title),
    body,
    toc,
    sections: sections
      .map((s) => ({ heading: s.heading, anchor: s.anchor, text: s.text.join(" ").replace(/\s+/g, " ").trim() }))
      .filter((s) => s.text || s.heading),
  };
}

// The docs are three columns wide, so the header and footer widen with them.
const docsStyle = `
.wrap,.dwrap{max-width:1440px;margin:0 auto;padding:0 24px;box-sizing:border-box}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dbar{border-bottom:1px solid #161A22;background:#0D1015}
.dbar-row{display:flex;align-items:center;gap:12px 20px;flex-wrap:wrap;min-height:64px;padding-top:10px;padding-bottom:10px}
.dsearch{flex:1 1 360px;max-width:640px;display:flex;align-items:center;gap:12px;min-height:44px;margin:0;padding:0 12px 0 14px;border:1px solid #2A3040;border-radius:8px;background:#0A0C10}
.dsearch:focus-within{border-color:#7C9BFF}
.dsearch input{flex:1;min-width:0;height:42px;border:0;background:transparent;color:#FFFFFF;font-family:inherit;font-size:15px;outline:none}
.kbd{padding:2px 7px;border:1px solid #2A3040;border-radius:6px;font-size:12px;color:#9AA3B2}
.dcols{display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start;padding-top:32px;padding-bottom:96px}
.side{flex:1 1 240px;max-width:280px;display:flex;flex-direction:column;gap:4px;font-size:14px}
.side a{display:block;padding:7px 12px;border-radius:6px;color:#AEB5C2;text-decoration:none;font-size:14px;line-height:1.45}
.side a:hover{background:#11141B;color:#FFFFFF}
.side a[aria-current]{background:#141A2B;color:#FFFFFF;box-shadow:inset 2px 0 0 #7C9BFF}
.side summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;min-height:40px;padding:0 12px;font-size:13px;font-weight:600;color:#E8EAEE;border-radius:6px}
.side summary:hover{background:#11141B}
.side summary::-webkit-details-marker{display:none}
.side .n{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12px;color:#8B93A3;font-weight:400}
.dmain{flex:999 1 560px;min-width:0;max-width:820px}
.toc{flex:1 1 200px;max-width:240px;display:flex;flex-direction:column;gap:2px}
.toc a{display:block;padding:5px 0 5px 12px;border-left:1px solid #1F2430;color:#8B93A3;text-decoration:none;font-size:13px;line-height:1.45}
.toc a.h3{padding-left:24px}
.toc a:hover{color:#FFFFFF;border-left-color:#7C9BFF}
.prose{font-size:17px;line-height:1.7;color:#C9CED8;overflow-wrap:break-word}
.prose h2{margin:56px 0 16px;font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-0.01em;color:#FFFFFF;scroll-margin-top:24px}
.prose h3{margin:36px 0 12px;font-size:20px;line-height:1.3;font-weight:600;color:#FFFFFF;scroll-margin-top:24px}
.prose h4,.prose h5,.prose h6{margin:28px 0 10px;font-size:17px;font-weight:600;color:#FFFFFF}
.prose p{margin:0 0 16px}
.prose ul,.prose ol{margin:0 0 16px;padding-left:24px}
.prose li{margin:0 0 8px}
.prose li>ul,.prose li>ol{margin:8px 0 0}
.prose strong{color:#E8EAEE;font-weight:600}
.prose hr{border:0;border-top:1px solid #1F2430;margin:40px 0}
.prose blockquote{margin:0 0 16px;padding:4px 0 4px 18px;border-left:3px solid #2A3040;color:#AEB5C2}
.prose code{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:14px;padding:2px 6px;border-radius:5px;background:#161A22;border:1px solid #1F2430;color:#E8EAEE}
.prose pre.code{margin:0 0 20px;background:#0D1015;border:1px solid #1F2430;border-radius:10px}
.prose pre.code code{padding:0;border:0;background:none;font-size:13px;color:#C9CED8}
.prose pre.mermaid{margin:0 0 20px;padding:20px;background:#0D1015;border:1px solid #1F2430;border-radius:10px;overflow-x:auto;text-align:center;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:13px;color:#8B93A3;white-space:pre}
.prose img{max-width:100%;height:auto;background:#FFFFFF;border-radius:10px;padding:24px;box-sizing:border-box}
.prose .anchor{margin-left:10px;color:#3A4152;text-decoration:none;font-weight:400}
.prose h2:hover .anchor,.prose h3:hover .anchor,.prose .anchor:focus{color:#7C9BFF}
.tbl{overflow-x:auto;margin:0 0 20px;border:1px solid #1F2430;border-radius:10px}
.tbl table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.55}
.tbl th{text-align:left;padding:12px 14px;background:#11141B;color:#E8EAEE;font-weight:600;border-bottom:1px solid #1F2430;vertical-align:bottom}
.tbl td{padding:12px 14px;border-bottom:1px solid #161A22;vertical-align:top;color:#AEB5C2}
.tbl tr:last-child td{border-bottom:0}
.tbl code{font-size:13px}
.pn{display:flex;gap:16px;flex-wrap:wrap;margin-top:56px;padding-top:28px;border-top:1px solid #161A22}
.pn a{flex:1 1 260px;display:flex;flex-direction:column;gap:6px;padding:18px 20px;border:1px solid #1F2430;border-radius:10px;text-decoration:none}
.pn a:hover{border-color:#7C9BFF}
.filter{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid #2A3040;background:transparent;color:#C9CED8;font-family:inherit;font-size:14px;cursor:pointer}
.filter:hover{border-color:#7C9BFF;color:#FFFFFF}
.filter[aria-pressed="true"]{background:#141A2B;border-color:#7C9BFF;color:#FFFFFF}
.hit{display:flex;flex-direction:column;gap:6px;padding:20px 22px;border-bottom:1px solid #161A22;text-decoration:none}
.hit:hover{background:#0F1218}
.hit:last-child{border-bottom:0}
mark{background:#2B3A66;color:#FFFFFF;border-radius:3px;padding:0 2px}
@media (max-width: 1000px){.side{order:3;max-width:none}.toc{display:none}.dmain{max-width:none}}
@media (max-width: 600px){.prose h2{font-size:24px!important}}
`;

function head({ title, description, path, type, noindex }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ""}<link rel="canonical" href="${SITE}${path}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="Vennir">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Vennir: every team's automation, one workflow. Nobody's credentials shared.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>${siteStyle}${docsStyle}</style>
</head>
<body>
<div style="font-family: 'IBM Plex Sans', system-ui, sans-serif; color: #E8EAEE; background: #0A0C10; min-height: 100vh">

  ${header}
`;
}

// Every docs page's bar: a search over every guide's full text. A plain
// form, so it works without the script too.
const searchIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3B2" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path></svg>';
const docsBar = `
  <div class="dbar">
    <div class="dwrap dbar-row">
      <a href="/docs" style="font-size: 16px; font-weight: 600; color: #FFFFFF; text-decoration: none">Vennir docs</a>
      <form class="dsearch" role="search" action="/docs/search" method="get">
        <label for="docs-q" class="sr">Search every guide</label>
        ${searchIcon}
        <input id="docs-q" name="q" type="search" placeholder="Search every guide: words, failure codes, commands…">
        <span class="mono kbd" aria-hidden="true">/</span>
      </form>
      <span class="mono" style="margin-left: auto; font-size: 12px; color: #8B93A3; border: 1px solid #2A3040; border-radius: 999px; padding: 4px 10px">From main · ${esc(version)} released</span>
    </div>
  </div>
`;

const tail = `
  ${footer}
</div>
<script src="/site.js" defer></script>
</body>
</html>
`;

function sideNav(current) {
  const groups = manifest.groups.map((group) => {
    const links = group.guides.map((g) => {
      const guide = bySource.get(g.source);
      const here = guide === current ? ' aria-current="page"' : "";
      return `<a href="/docs/${guide.slug}"${here}>${guide.title}</a>`;
    }).join("\n          ");
    const open = current?.group === group ? " open" : "";
    return `      <details${open}>
        <summary>${esc(group.label)} <span class="n">${group.guides.length}</span></summary>
        <div style="padding: 4px 0 8px">
          ${links}
        </div>
      </details>`;
  }).join("\n");
  return `    <nav class="side" aria-label="Every guide">
      <a href="/docs" style="font-weight: 600; color: #E8EAEE">Docs home</a>
${groups}
    </nav>`;
}

if (problems.length === 0) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}

const index = { groups: manifest.groups.map((g) => g.label), entries: [] };
for (const guide of problems.length === 0 ? guides : []) {
  const page = render(guide);
  const siblings = guide.group.guides.map((g) => bySource.get(g.source));
  const at = siblings.indexOf(guide);
  const prev = siblings[at - 1];
  const next = siblings[at + 1];
  const toc = page.toc.length === 0 ? "" : `
    <nav class="toc" aria-label="On this page">
      <span style="font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #8B93A3; margin-bottom: 8px">On this page</span>
      ${page.toc.map((t) => `<a href="#${esc(t.id)}"${t.level === "h3" ? ' class="h3"' : ""}>${esc(t.text)}</a>`).join("\n      ")}
    </nav>`;
  const html = head({ title: `${page.title} · Vennir docs`, description: unescapeHtml(guide.summary), path: `/docs/${guide.slug}`, type: "article" })
    + docsBar + `
  <div class="dwrap dcols">
${sideNav(guide)}

    <main class="dmain">
      <nav aria-label="Breadcrumb" style="display: flex; gap: 8px; flex-wrap: wrap; font-size: 14px; color: #8B93A3">
        <a href="/docs" style="color: #8B93A3; text-decoration: none">Docs</a><span aria-hidden="true">›</span>
        <a href="/docs#${guide.group.id}" style="color: #8B93A3; text-decoration: none">${esc(guide.group.label)}</a><span aria-hidden="true">›</span>
        <span aria-current="page" style="color: #C9CED8">${guide.title}</span>
      </nav>
      <h1 style="margin: 18px 0 14px; font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; color: #FFFFFF; text-wrap: balance">${esc(page.title)}</h1>
      <div style="display: flex; gap: 10px 18px; flex-wrap: wrap; align-items: center; font-size: 13px; color: #8B93A3; padding-bottom: 24px; border-bottom: 1px solid #161A22">
        <span class="mono">${esc(guide.source)}</span>
        <a href="${GITHUB}/blob/main/${encodeURI(guide.source)}" style="font-size: 13px">View on GitHub</a>
        <a href="${GITHUB}/edit/main/${encodeURI(guide.source)}" style="font-size: 13px">Suggest a change</a>
        ${servedByConsole(guide.source) ? "<span>Also on every install's Docs page</span>" : ""}
      </div>
      <div class="prose" style="padding-top: 28px">
${page.body}      </div>
      <div class="pn">
        ${prev ? `<a href="/docs/${prev.slug}"><span style="font-size: 13px; color: #8B93A3">← Previous</span><span style="font-size: 16px; font-weight: 600; color: #FFFFFF">${prev.title}</span></a>` : ""}
        ${next ? `<a href="/docs/${next.slug}" style="text-align: right"><span style="font-size: 13px; color: #8B93A3">Next →</span><span style="font-size: 16px; font-weight: 600; color: #FFFFFF">${next.title}</span></a>` : ""}
      </div>
    </main>
${toc}
  </div>
` + tail;
  writeFileSync(join(out, `${guide.slug}.html`), html);
  for (const s of page.sections) {
    index.entries.push({ s: guide.slug, t: page.title, g: guide.group.label, h: s.heading, a: s.anchor, x: s.text });
  }
}

if (problems.length === 0) {
  // The search page: the script fills it in from search-index.json.
  writeFileSync(join(out, "search.html"), head({
    title: "Search the Vennir docs",
    description: "Search the full text of every Vennir guide.",
    path: "/docs/search",
    type: "website",
    noindex: true,
  }) + docsBar + `
  <main class="dwrap" style="max-width: 960px; padding-top: 56px; padding-bottom: 96px; display: flex; flex-direction: column; gap: 24px">
    <a href="/docs" style="font-size: 14px; color: #8B93A3; text-decoration: none">← Vennir docs</a>
    <form role="search" action="/docs/search" method="get" style="display: flex; flex-direction: column; gap: 12px; margin: 0">
      <label for="search-q" style="font-size: 14px; color: #8B93A3">Search every guide: titles, sections and the full text</label>
      <div class="dsearch" style="flex: none; max-width: none; min-height: 56px; border-radius: 10px">
        ${searchIcon}
        <input id="search-q" name="q" type="search" placeholder="Try: federated credential, IMAGE_NOT_ALLOWED, cart" style="font-size: 17px; height: 54px">
      </div>
    </form>
    <div id="search-filters" role="group" aria-label="Show results from" style="display: flex; gap: 10px; flex-wrap: wrap"></div>
    <p id="search-summary" aria-live="polite" style="margin: 0; font-size: 15px; color: #AEB5C2">Searching needs the page's script; without it, <a href="/docs">every guide is listed on the Docs page</a>.</p>
    <div id="search-results" hidden style="border: 1px solid #1F2430; border-radius: 12px; overflow: hidden; background: #0B0E13"></div>
    <div id="search-none" hidden style="padding: 28px; border: 1px dashed #2A3040; border-radius: 12px; font-size: 15px; line-height: 1.6; color: #AEB5C2">No guide says that. Try fewer or other words, or <a href="${GITHUB}/issues">ask in an issue</a>: a question the docs don't answer is a gap worth filing.</div>
    <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.6; color: #8B93A3">The search runs in this page, from an index made with the guides at each deploy: nothing you type leaves your browser. Inside an install, the console's Docs page searches that version's guides, and Ask answers from them.</p>
  </main>
` + tail);
  writeFileSync(join(out, "search-index.json"), JSON.stringify(index));
  // Mermaid draws the guides' diagrams in the browser; the site's CSP
  // allows only its own scripts, so it's served from here.
  copyFileSync(join(here, "node_modules/mermaid/dist/mermaid.min.js"), join(out, "mermaid.min.js"));
}

if (problems.length) {
  console.error(`site docs: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`site docs: ${guides.length} guides, ${index.entries.length} sections indexed, into site/public/docs/`);
