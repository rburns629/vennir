// SPDX-License-Identifier: MIT
// The site's only script: the home page's hero run, the copy button beside
// the install command, the Docs page's filter, the docs' full-text search,
// and drawing a guide's diagrams. It writes into the page only as text and
// elements it makes, never markup: its own constant text, the search index's
// text, and what a visitor typed, as text.
(function () {
  "use strict";

  // Firebase also serves the site at the project's own addresses; send
  // visitors to vennir.io, the one every page names as canonical. Preview
  // channels (a "--" in the name) stay where they are.
  var host = location.hostname;
  if (/\.(web\.app|firebaseapp\.com)$/.test(host) && host.indexOf("--") === -1) {
    location.replace("https://vennir.io" + location.pathname + location.search + location.hash);
    return;
  }

  // The hero's run, phase by phase: project, then the database, then the app
  // once a maintainer approves, then the ticket; then it starts over. Still on
  // phase 2 (waiting for approval) for anyone who asks for less motion.
  var PHASES = [2400, 2400, 2600, 1800, 2400, 3400];
  var STILL = 2;
  var C = { ok: "#8FD6B4", run: "#7C9BFF", runText: "#A9BCFF", wait: "#F2C08A", idle: "#8B93A3" };
  var LOGS = [
    [["12:04:10", "project.create · INFO creating project rf-api-7f2c", C.runText]],
    [["12:04:51", "project.create · INFO created project rf-api-7f2c", C.ok], ["12:04:53", "cloud-sql.create · INFO instance refunds-db starting", C.runText]],
    [["12:06:02", "cloud-sql.create · INFO instance refunds-db ready", C.ok], ["12:06:03", "app-hosting.create · waiting for a payments maintainer", C.wait]],
    [["12:06:40", "app-hosting.create · approved by ana@acme.com", C.ok]],
    [["12:07:15", "app-hosting.create · INFO refunds-api serving", C.ok], ["12:07:16", "ticket.open · INFO opening ticket for refunds-api", C.runText]],
    [["12:07:22", "run · Succeeded: 4 steps from 3 teams", C.ok]],
  ];
  var ELAPSED = ["0m 08s", "0m 49s", "2m 00s", "2m 37s", "3m 13s", "3m 19s"];
  var APPROVAL = "border-color: #6B4A1F; color: #F2C08A";
  var APPROVED = "border-color: #2E5A47; color: #8FD6B4";
  var HIDDEN = "display: none";

  function step(name, team, extra, extraStyle, indent, left, width, color, status, textColor) {
    return { name: name, team: team, extra: extra, extraStyle: extraStyle, indent: indent, left: left, width: width, color: color, status: status, textColor: textColor };
  }

  function steps(p) {
    var project = p === 0
      ? step("project.create", "platform", "as gcp-project", "", 0, 0, 14, C.run, "Running · creating the project", C.runText)
      : step("project.create", "platform", "as gcp-project", "", 0, 0, 22, C.ok, "Succeeded · 41s · projectId → next", C.ok);
    var database = p === 0
      ? step("cloud-sql.create", "data-platform", "secret: db-admin", "", 24, 22, 0, C.run, "Waiting for project", C.idle)
      : p === 1
        ? step("cloud-sql.create", "data-platform", "secret: db-admin", "", 24, 22, 20, C.run, "Running · attempt 1 of 3", C.runText)
        : step("cloud-sql.create", "data-platform", "secret: db-admin", "", 24, 22, 30, C.ok, "Succeeded · 1m 09s", C.ok);
    var app = p < 2
      ? step("app-hosting.create", "payments", "needs approval", APPROVAL, 24, 52, 0, C.run, "Waiting for the database", C.idle)
      : p === 2
        ? step("app-hosting.create", "payments", "needs approval", APPROVAL, 24, 52, 0, C.wait, "Waiting on a maintainer", C.wait)
        : p === 3
          ? step("app-hosting.create", "payments", "approved", APPROVED, 24, 52, 12, C.run, "Running · deploying", C.runText)
          : step("app-hosting.create", "payments", "approved", APPROVED, 24, 52, 26, C.ok, "Succeeded · 35s", C.ok);
    var ticket = p < 4
      ? step("ticket.open", "payments", "", HIDDEN, 48, 80, 0, C.run, "Waiting for app-hosting", C.idle)
      : p === 4
        ? step("ticket.open", "payments", "", HIDDEN, 48, 80, 8, C.run, "Running", C.runText)
        : step("ticket.open", "payments", "", HIDDEN, 48, 80, 12, C.ok, "Succeeded · 6s", C.ok);
    return [project, database, app, ticket];
  }

  function logs(p) {
    var all = [];
    for (var i = 0; i <= p; i++) all = all.concat(LOGS[i]);
    return all.slice(-3);
  }

  // Each row and log line is laid out once in the page; a phase only changes
  // their text and styles, so the bars' widths animate between phases.
  function show(root, p) {
    var done = p === 5;
    root.querySelector("[data-run=elapsed]").textContent = ELAPSED[p];
    var chip = root.querySelector("[data-run=chip]");
    chip.style.borderColor = done ? "#2E5A47" : p === 2 ? "#6B4A1F" : "#2F5BD3";
    chip.style.color = done ? "#8FD6B4" : p === 2 ? "#F2C08A" : "#A9BCFF";
    var dot = root.querySelector("[data-run=dot]");
    dot.style.background = done ? C.ok : p === 2 ? C.wait : C.run;
    dot.className = done || p === 2 ? "" : "pulse";
    root.querySelector("[data-run=state]").textContent = done ? "Succeeded" : p === 2 ? "Waiting on approval" : "Running";

    var rows = root.querySelectorAll("[data-run=step]");
    steps(p).forEach(function (s, i) {
      var row = rows[i];
      var extra = row.querySelector("[data-run=extra]");
      extra.textContent = s.extra;
      extra.setAttribute("style", s.extraStyle);
      var bar = row.querySelector("[data-run=bar]");
      bar.style.left = s.left + "%";
      bar.style.width = s.width + "%";
      bar.style.background = s.color;
      var status = row.querySelector("[data-run=status]");
      status.textContent = s.status;
      status.style.color = s.textColor;
    });

    var lines = root.querySelectorAll("[data-run=log]");
    var shown = logs(p);
    lines.forEach(function (el, i) {
      var line = shown[i];
      el.hidden = !line;
      if (!line) return;
      var at = el.querySelector("[data-run=at]");
      at.textContent = line[0];
      at.style.color = line[2];
      el.querySelector("[data-run=text]").textContent = " " + line[1];
    });
  }

  function hero() {
    var root = document.getElementById("hero-run");
    if (!root) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var phase = 0;
    show(root, phase);
    (function next() {
      setTimeout(function () {
        phase = (phase + 1) % PHASES.length;
        show(root, phase);
        next();
      }, PHASES[phase]);
    })();
  }

  function copyButtons() {
    document.querySelectorAll("[data-copy]").forEach(function (button) {
      var label = button.getAttribute("aria-label");
      button.addEventListener("click", function () {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(button.getAttribute("data-copy")).then(function () {
          button.setAttribute("aria-label", "Copied");
          button.style.color = C.ok;
          setTimeout(function () {
            button.setAttribute("aria-label", label);
            button.style.color = "";
          }, 1600);
        });
      });
    });
  }

  // The Docs page: typing hides the guides whose title and summary don't
  // match, and with them the groups left empty and the sections above the
  // guides, so what matches comes right after the box; the line under the box
  // says how many. Enter submits the box's form: the full-text search.
  function docsFilter() {
    var input = document.getElementById("docs-search");
    if (!input) return;
    function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
    var cards = all("[data-doc]");
    var groups = all("[data-doc-group]");
    var browse = all("[data-browse]");
    var none = document.getElementById("docs-none");
    var hint = document.getElementById("docs-hint");
    var hintText = hint && hint.textContent;
    // Each element's own inline display would win over the hidden attribute,
    // so hiding sets it to none and showing puts its own back.
    var displays = new Map();
    cards.concat(groups, browse).forEach(function (el) { displays.set(el, el.style.display); });
    function show(el, visible) { el.style.display = visible ? displays.get(el) : "none"; }
    input.addEventListener("input", function () {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      cards.forEach(function (card) {
        var text = card.textContent.toLowerCase();
        var match = words.every(function (w) { return text.indexOf(w) !== -1; });
        show(card, match);
        if (match) shown++;
      });
      groups.forEach(function (group) {
        show(group, cards.some(function (card) { return card.style.display !== "none" && group.contains(card); }));
      });
      browse.forEach(function (section) { show(section, words.length === 0); });
      if (none) none.hidden = shown > 0;
      if (hint) {
        hint.textContent = words.length === 0 ? hintText
          : (shown === 0 ? "No guide's title matches that." : (shown === 1 ? "1 guide's title matches" : shown + " guides' titles match") + ", below.")
            + " Enter searches every guide's full text.";
      }
    });
  }

  // "/" jumps to the page's docs search box, wherever focus isn't in a field.
  function slashToSearch() {
    var input = document.getElementById("docs-search") || document.getElementById("search-q") || document.getElementById("docs-q");
    if (!input) return;
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      input.focus();
    });
  }

  // The search page (/docs/search?q=…): every guide's sections, from the
  // index the site's build made, matched as the visitor types. Every result
  // is built from elements and text, never markup.
  function fullSearch() {
    var results = document.getElementById("search-results");
    if (!results) return;
    var input = document.getElementById("search-q");
    var filters = document.getElementById("search-filters");
    var summary = document.getElementById("search-summary");
    var none = document.getElementById("search-none");
    var index = null;
    var group = "All";
    var LIMIT = 100;

    function el(tag, text, style) {
      var e = document.createElement(tag);
      if (text != null) e.textContent = text;
      if (style) e.setAttribute("style", style);
      return e;
    }
    function words() { return input.value.toLowerCase().split(/\s+/).filter(Boolean); }
    function matches(ws) {
      var hits = [];
      index.entries.forEach(function (entry, order) {
        var title = entry.t.toLowerCase(), heading = entry.h.toLowerCase(), text = entry.x.toLowerCase();
        var all = title + " " + heading + " " + text;
        if (!ws.every(function (w) { return all.indexOf(w) !== -1; })) return;
        var score = 0;
        if (ws.every(function (w) { return title.indexOf(w) !== -1; })) score += 20;
        if (ws.every(function (w) { return heading.indexOf(w) !== -1; })) score += 10;
        // Each time the section says it all together, up to five.
        score += Math.min(5, text.split(ws.join(" ")).length - 1);
        hits.push({ entry: entry, score: score, order: order });
      });
      hits.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
      return hits;
    }
    // The text around the first place it says what was typed, the match marked.
    function snippet(text, ws) {
      var lower = text.toLowerCase(), phrase = ws.join(" ");
      var at = lower.indexOf(phrase), len = phrase.length;
      if (at === -1) { at = lower.indexOf(ws[0]); len = ws[0].length; }
      var span = el("span", null, "font-size: 15px; line-height: 1.6; color: #AEB5C2");
      if (at === -1) { span.textContent = text.slice(0, 200) + (text.length > 200 ? "…" : ""); return span; }
      var start = Math.max(0, at - 90), end = Math.min(text.length, at + len + 120);
      span.appendChild(document.createTextNode((start > 0 ? "…" : "") + text.slice(start, at)));
      span.appendChild(el("mark", text.slice(at, at + len)));
      span.appendChild(document.createTextNode(text.slice(at + len, end) + (end < text.length ? "…" : "")));
      return span;
    }
    function render() {
      var ws = words();
      var q = input.value.trim();
      var url = q ? "/docs/search?q=" + encodeURIComponent(q) : "/docs/search";
      history.replaceState(null, "", url);
      document.title = q ? q + " · Search the Vennir docs" : "Search the Vennir docs";
      var hits = ws.length ? matches(ws) : [];
      filters.textContent = "";
      if (ws.length) {
        ["All"].concat(index.groups).forEach(function (name) {
          var count = name === "All" ? hits.length : hits.filter(function (h) { return h.entry.g === name; }).length;
          if (name !== "All" && count === 0) return;
          var button = el("button", name + " ", null);
          button.type = "button";
          button.className = "filter";
          button.setAttribute("aria-pressed", String(group === name));
          button.appendChild(el("span", String(count), "font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; color: #8B93A3"));
          button.addEventListener("click", function () { group = name; render(); });
          filters.appendChild(button);
        });
      }
      var shown = hits.filter(function (h) { return group === "All" || h.entry.g === group; });
      results.textContent = "";
      shown.slice(0, LIMIT).forEach(function (hit) {
        var e = hit.entry;
        var a = el("a", null, null);
        a.className = "hit";
        a.href = "/docs/" + e.s + (e.a ? "#" + e.a : "");
        var title = el("span", e.t, "font-size: 18px; font-weight: 600; color: #FFFFFF");
        if (e.h) title.appendChild(el("span", " › " + e.h, "font-weight: 400; color: #8B93A3"));
        a.appendChild(title);
        a.appendChild(snippet(e.x || e.h, ws));
        a.appendChild(el("span", e.g, "font-size: 12px; color: #8B93A3"));
        results.appendChild(a);
      });
      results.hidden = shown.length === 0;
      none.hidden = !(ws.length && shown.length === 0);
      var guides = {};
      shown.forEach(function (h) { guides[h.entry.s] = true; });
      var n = Object.keys(guides).length;
      summary.textContent = !ws.length ? "Type to search every guide."
        : !shown.length ? "No results for “" + q + "”."
        : shown.length + (shown.length === 1 ? " section" : " sections") + " in " + n + (n === 1 ? " guide" : " guides")
          + " for “" + q + "”" + (shown.length > LIMIT ? ", the first " + LIMIT + " shown" : "");
    }

    input.value = new URLSearchParams(location.search).get("q") || "";
    summary.textContent = "Loading the index…";
    fetch("/docs/search-index.json").then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (data) {
      index = data;
      render();
      input.addEventListener("input", function () { group = "All"; render(); });
      input.form.addEventListener("submit", function (e) { e.preventDefault(); render(); });
      input.addEventListener("keydown", function (e) { if (e.key === "Escape") { input.value = ""; group = "All"; render(); } });
      if (!input.value) input.focus();
    }).catch(function () {
      summary.textContent = "The search index didn't load. Try again in a moment.";
    });
  }

  // A guide's diagrams (```mermaid) are drawn in the browser, by Mermaid,
  // fetched only on a page that has one.
  function diagrams() {
    var blocks = document.querySelectorAll("pre.mermaid");
    if (!blocks.length) return;
    var script = document.createElement("script");
    script.src = "/docs/mermaid.min.js";
    script.onload = function () {
      window.mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "IBM Plex Sans, system-ui, sans-serif" });
      window.mermaid.run({ nodes: blocks });
    };
    document.head.appendChild(script);
  }

  document.addEventListener("DOMContentLoaded", function () {
    hero();
    copyButtons();
    docsFilter();
    slashToSearch();
    fullSearch();
    diagrams();
  });
})();
