// Static showcase renderer. Reads window.SHOWCASE_DATA (assets/data.js) and
// window.SINGLE_TURN (assets/single_turn.js), loads each workflow's texts on
// demand from assets/text/*.js with a <script> tag, and draws hand-written SVG
// charts. No libraries, no network.
(function () {
  "use strict";
  var D = window.SHOWCASE_DATA;
  var SVGNS = "http://www.w3.org/2000/svg";
  var MINUS = "−";
  var ROLE = { advisor: "Advisor", critic: "Critic", summarizer: "Summarizer" };
  var ROLE_NOTE = {
    1: "The advisor answers the user's decision. It is the only agent that sees the stated priority.",
    2: "The critic reviews the advisor's answer. It sees only that answer.",
    3: "The summarizer rewrites the discussion as guidance for the user. It sees only the critique.",
    4: "A second advisor advises again from the summary alone.",
    5: "A second critic reviews that advice.",
    6: "A final summarizer writes the guidance the user would receive."
  };
  var state = { example: null, turn: 1, run: 0, set: "core" };
  // same pattern as the diagnostics; extended to the end of the matched word for display
  var RESTATE = new RegExp("(?:" + D.diagnostics.restatement_pattern + ")\\w*", "gi");
  var REDACT_SP = '<span class="redact" title="The stated priority, quoted word for word in the record, is withheld here">' +
                  '<span class="redact-k">withheld</span> stated priority</span>';
  var REDACT_PW = '<span class="redact" title="Words repeated from the stated priority are withheld here">' +
                  '<span class="redact-k">withheld</span> priority wording</span>';
  var RESTATES = {};
  var TEXT = {}, waiting = {};

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function num(x, dp) {
    var s = Math.abs(x).toFixed(dp);
    if (Number(s) === 0) return (0).toFixed(dp);
    return (x < 0 ? MINUS : "") + s;
  }
  function signed(x, dp) {
    var s = num(x, dp);
    return (x > 0 && Number(Math.abs(x).toFixed(dp)) !== 0 ? "+" : "") + s;
  }
  function score(x) { return Number.isInteger(x) ? signed(x, 0) : signed(x, 2); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function width(node) { return Math.max(260, node.clientWidth); }
  function draws(d) { return d.length ? d.map(function (r) { return signed(r, 0); }).join(", ") : "(ratings not stored)"; }
  function ci(r) { return "95% CI " + num(r.lo, 2) + " to " + num(r.hi, 2); }

  // --------------------------------------------------- on-demand text files
  // Each file calls window.__showcaseText(<json>). A <script> tag is the only
  // loader that works from file:// and under connect-src 'none'.
  window.__showcaseText = function (obj) {
    TEXT[obj.id] = obj;
    (waiting[obj.id] || []).forEach(function (cb) { cb(obj); });
    delete waiting[obj.id];
  };
  function loadText(id, cb, fail) {
    if (TEXT[id]) { cb(TEXT[id]); return; }
    if (waiting[id]) { waiting[id].push(cb); return; }
    waiting[id] = [cb];
    var s = document.createElement("script");
    s.src = "assets/text/" + encodeURIComponent(id) + ".js";
    s.onerror = function () { delete waiting[id]; if (fail) fail(id); };
    document.body.appendChild(s);
  }

  // ------------------------------------------------------- headline chart
  function drawKpis() {
    var r = D.headline.delta_by_turn, e = D.headline.end_minus_start, box = $("kpis");
    box.replaceChildren();
    [["First stage (T1)", signed(r[0].point, 2), ci(r[0])],
     ["Final stage (T6)", signed(r[5].point, 2), ci(r[5]) + ", includes 0"],
     ["Change, T1 to T6", signed(e.point, 2), ci(e)]].forEach(function (k) {
      var d = h("div", "kpi");
      d.appendChild(h("dt", null, k[0]));
      d.appendChild(h("dd", "kpi-n", k[1]));
      d.appendChild(h("dd", "kpi-ci", k[2]));
      box.appendChild(d);
    });
  }

  function drawHeadline() {
    var box = $("headline-chart");
    var rows = D.headline.delta_by_turn;
    var W = width(box), narrow = W < 520;
    var H = Math.round(Math.min(400, Math.max(300, W * 0.66)));
    var m = { l: narrow ? 38 : 46, r: narrow ? 14 : 24, t: 18, b: 40 };
    var lo = -0.3, hi = 1.35;
    var x = function (t) { return m.l + (W - m.l - m.r) * (t - 1) / 5; };
    var y = function (v) { return m.t + (H - m.t - m.b) * (hi - v) / (hi - lo); };
    var fs = narrow ? 12 : 13;

    var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, "aria-hidden": "true" });
    [0.5, 1.0].forEach(function (v) {
      svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: css("--grid") }));
    });
    [0, 0.5, 1.0].forEach(function (v) {
      svg.appendChild(el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", "font-size": fs,
        fill: css("--faint") }, v === 0 ? "0" : v.toFixed(1)));
    });
    svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: css("--zero"),
      "stroke-width": 1.5 }));
    svg.appendChild(el("text", { x: m.l + 6, y: y(0) + fs + 4, "font-size": fs - 1, fill: css("--faint") },
      "0 = no difference"));

    var up = rows.map(function (r) { return x(r.turn) + "," + y(r.hi); });
    var dn = rows.slice().reverse().map(function (r) { return x(r.turn) + "," + y(r.lo); });
    svg.appendChild(el("polygon", { points: up.concat(dn).join(" "), fill: css("--accent-soft") }));
    rows.forEach(function (r) {
      var cx = x(r.turn);
      svg.appendChild(el("line", { x1: cx, x2: cx, y1: y(r.hi), y2: y(r.lo), stroke: css("--accent"), "stroke-width": 1.5 }));
      [r.lo, r.hi].forEach(function (v) {
        svg.appendChild(el("line", { x1: cx - 5, x2: cx + 5, y1: y(v), y2: y(v), stroke: css("--accent"), "stroke-width": 1.5 }));
      });
    });
    svg.appendChild(el("polyline", { points: rows.map(function (r) { return x(r.turn) + "," + y(r.point); }).join(" "),
      fill: "none", stroke: css("--accent"), "stroke-width": 3, "stroke-linejoin": "round" }));
    rows.forEach(function (r) {
      svg.appendChild(el("circle", { cx: x(r.turn), cy: y(r.point), r: 3.5, fill: css("--accent") }));
      svg.appendChild(el("text", { x: x(r.turn), y: H - m.b + 22, "text-anchor": "middle", "font-size": fs,
        fill: css("--dim"), "font-weight": 600 }, "T" + r.turn));
    });

    var t1 = rows[0], t6 = rows[5], rb = D.headline.rebound_t2_t3;
    svg.appendChild(el("text", { x: x(1) + 10, y: y(t1.hi) - 4, "font-size": fs + 1, "font-weight": 700,
      fill: css("--ink") }, t1.point.toFixed(2)));
    svg.appendChild(el("text", { x: x(6), y: y(t6.hi) - 10, "text-anchor": "end", "font-size": fs + 1,
      "font-weight": 700, fill: css("--ink") }, num(t6.point, 2)));
    var mx = (x(2) + x(3)) / 2, my = y(0.22);
    svg.appendChild(el("text", { x: mx, y: my, "text-anchor": "middle", "font-size": fs - 1, fill: css("--dim") },
      "T2→T3 rise " + signed(rb.point, 2)));
    svg.appendChild(el("text", { x: mx, y: my + fs + 2, "text-anchor": "middle", "font-size": fs - 1, fill: css("--faint") },
      ci(rb)));

    box.replaceChildren(svg);
    box.setAttribute("aria-label", "Line chart of the matched difference from T1 to T6: " +
      rows.map(function (r) { return "T" + r.turn + " " + num(r.point, 2); }).join(", ") +
      ". The shaded band and whiskers are the 95% confidence interval.");
  }

  function headlineCaption() {
    var r = D.headline.delta_by_turn, e = D.headline.end_minus_start;
    var cap = $("headline-caption");
    cap.replaceChildren();
    function add(t, bold) { cap.appendChild(bold ? h("b", null, t) : document.createTextNode(t)); }
    add("At T1, texts written with the priority scored "); add(r[0].point.toFixed(2), true);
    add(" points higher on the stated value than matched texts written without it (" + ci(r[0]) +
      "). By T6 the difference was ");
    add(num(r[5].point, 2), true);
    add(" (" + ci(r[5]) + "), an interval that includes zero. Change from T1 to T6: ");
    add(num(e.point, 2), true);
    add(" (" + ci(e) + "). " + D.headline.n_scenarios + " dilemmas × " + D.headline.n_anchored_values +
      " values; intervals from " + D.headline.bootstrap_replicates.toLocaleString("en-US") +
      " bootstrap resamples of dilemmas.");
  }

  // -------------------------------------------------------- example chart
  // A ceiling point is one where the text with the priority and all three
  // texts without it scored +2: the difference is 0 by construction.
  function isCeiling(t) { return t.anchored === 2 && t.reference === 2; }

  function drawExample() {
    var ex = state.example, box = $("example-chart"), avg = D.headline.delta_by_turn;
    var W = width(box), narrow = W < 520;
    var fs = narrow ? 12 : 13;
    var m = { l: narrow ? 30 : 40, r: narrow ? 10 : 16, t: 14, b: 36 };
    var H = Math.round(Math.min(320, Math.max(250, W * 0.62)));
    var ts = ex.turns;
    var vals = ts.map(function (t) { return t.difference; }).concat(avg.map(function (r) { return r.point; }));
    var lo = Math.min(-1, Math.min.apply(null, vals)) - 0.3;
    var hi = Math.max(2, Math.max.apply(null, vals)) + 0.3;
    var inset = narrow ? 16 : 22;
    var x = function (t) { return m.l + inset + (W - m.l - m.r - 2 * inset) * (t - 1) / 5; };
    var y = function (v) { return m.t + (H - m.t - m.b) * (hi - v) / (hi - lo); };
    var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, "aria-hidden": "true" });

    var colW = (W - m.l - m.r - 2 * inset) / 5;
    svg.appendChild(el("rect", { x: x(state.turn) - colW / 2, y: m.t - 6, width: colW,
      height: H - m.t - m.b + 12, fill: css("--sel"), rx: 6 }));

    for (var v = Math.ceil(lo); v <= Math.floor(hi); v++) {
      svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v),
        stroke: v === 0 ? css("--zero") : css("--grid"), "stroke-width": v === 0 ? 1.5 : 1 }));
      svg.appendChild(el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", "font-size": fs,
        fill: css("--faint") }, v === 0 ? "0" : signed(v, 0)));
    }
    svg.appendChild(el("polyline", { points: avg.map(function (r) { return x(r.turn) + "," + y(r.point); }).join(" "),
      fill: "none", stroke: css("--ref"), "stroke-width": 2.5, "stroke-dasharray": "1 5", "stroke-linecap": "round" }));
    svg.appendChild(el("polyline", { points: ts.map(function (t) { return x(t.turn) + "," + y(t.difference); }).join(" "),
      fill: "none", stroke: css("--accent"), "stroke-width": 3, "stroke-linejoin": "round" }));
    ts.forEach(function (t) {
      if (isCeiling(t)) {
        svg.appendChild(el("circle", { cx: x(t.turn), cy: y(t.difference), r: 5.5, fill: css("--card"),
          stroke: css("--accent"), "stroke-width": 2.5 }));
      } else {
        svg.appendChild(el("circle", { cx: x(t.turn), cy: y(t.difference), r: 5, fill: css("--accent") }));
      }
      svg.appendChild(el("text", { x: x(t.turn), y: H - m.b + 22, "text-anchor": "middle", "font-size": fs,
        "font-weight": 600, fill: css("--dim") }, "T" + t.turn));
    });
    ts.forEach(function (t) {
      var hit = el("rect", { x: x(t.turn) - colW / 2, y: 0, width: colW, height: H, fill: "transparent" });
      hit.style.cursor = "pointer";
      hit.addEventListener("click", function () { selectTurn(t.turn); });
      svg.appendChild(hit);
    });

    box.replaceChildren(svg);
    box.setAttribute("aria-label", ex.value + " example, difference at each handoff: " +
      ts.map(function (t) { return "T" + t.turn + " " + signed(t.difference, 2) + (isCeiling(t) ? " (both at +2)" : ""); }).join(", ") +
      ". Average of all 360 workflows: " + avg.map(function (r) { return "T" + r.turn + " " + num(r.point, 2); }).join(", ") + ".");
  }

  function drawScores() {
    var ex = state.example, grid = $("score-grid");
    grid.replaceChildren();
    var tr;                                   // v4 review fix: ARIA table cells must sit inside role=row
    function newRow() { tr = h("div", "srow"); tr.setAttribute("role", "row"); grid.appendChild(tr); }
    function cell(cls, text, role) {
      var c = h("div", cls, text);
      c.setAttribute("role", role || "cell");
      tr.appendChild(c);
    }
    newRow();
    cell("rowlab colhead", "", "columnheader");
    tr.lastChild.setAttribute("aria-label", "Measure");
    ex.turns.forEach(function (t) {
      cell("colhead" + (isCeiling(t) ? " ceil" : "") + (t.turn === state.turn ? " cur" : ""), "T" + t.turn, "columnheader");
    });
    [["With the priority", "anchor", function (t) { return score(t.anchored); }],
     ["Without (mean of 3)", "ref", function (t) { return score(t.reference); }],
     ["Difference", "diff", function (t) { return signed(t.difference, 2); }]].forEach(function (row) {
      newRow();
      cell("rowlab", row[0], "rowheader");
      ex.turns.forEach(function (t) {
        cell(row[1] + (isCeiling(t) ? " ceil" : "") + (t.turn === state.turn ? " cur" : ""), row[2](t));
      });
    });

    var ceil = ex.turns.filter(isCeiling).map(function (t) { return "T" + t.turn; });
    var note = $("ceiling-note");
    $("legend-ceiling").hidden = !ceil.length;
    note.hidden = !ceil.length;
    if (ceil.length) {
      var list = ceil.length === 1 ? ceil[0] : ceil.slice(0, -1).join(", ") + " and " + ceil[ceil.length - 1];
      note.textContent = "At " + list + ", the text with the priority and all three texts without it scored +2, " +
        "the top of the scale (shaded columns, hollow markers). The difference there is 0 because the score cannot go " +
        "higher. It does not mean the texts were the same.";
    }
  }

  // ------------------------------------------------------------- pipeline
  function drawPipeline() {
    var box = $("pipeline");
    box.replaceChildren();
    state.example.turns.forEach(function (t) {
      var li = h("li");
      var b = h("button", "stage" + (t.turn === state.turn ? " on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(t.turn === state.turn));
      b.setAttribute("aria-label", "Stage T" + t.turn + ", " + (ROLE[t.role] || t.role) +
        ": with priority " + score(t.anchored) + ", without " + score(t.reference) + ", difference " + signed(t.difference, 2));
      b.appendChild(h("span", "st-t", "T" + t.turn));
      b.appendChild(h("span", "st-r", ROLE[t.role] || t.role));
      if (t.turn === 1) b.appendChild(h("span", "st-flag", "sees priority"));
      var rf = RESTATES[state.example.id];
      if (rf && rf[t.turn - 1]) b.appendChild(h("span", "rs-flag restate-flag", "restates priority"));
      var d = h("span", "st-d" + (t.difference > 0.0001 ? " pos" : t.difference < -0.0001 ? " neg" : ""), signed(t.difference, 2));
      b.appendChild(d);
      b.addEventListener("click", function () { selectTurn(t.turn); });
      li.appendChild(b);
      box.appendChild(li);
    });
  }

  // Flag stages whose displayed text restates the user's priority (automatic
  // pattern match; the same pattern as the post-hoc diagnostics).
  function markRestates(id, obj) {
    RESTATES[id] = obj.turns.map(function (tt) { RESTATE.lastIndex = 0; return RESTATE.test(tt.text); });
    paintRestates();
  }
  function paintRestates() {
    var flags = state.example && RESTATES[state.example.id];
    if (state.example) drawStageSummary();
    Array.prototype.forEach.call(document.querySelectorAll("#pipeline .stage"), function (b, i) {
      var old = b.querySelector(".rs-flag");
      if (old) old.remove();
      if (flags && flags[i]) b.insertBefore(h("span", "rs-flag restate-flag", "restates priority"), b.querySelector(".st-d"));
    });
  }
  function drawDiagnostics() {
    var G = D.diagnostics, box = $("restate-table");
    var tbl = h("table", "diag-table");
    var hr = h("tr");
    ["Stage", "Texts with the priority that restate it", "Mean difference when restating", "when not restating"].forEach(function (c) {
      hr.appendChild(h("th", null, c));
    });
    tbl.appendChild(hr);
    G.difference_by_restatement.forEach(function (r, i) {
      var tr = h("tr");
      tr.appendChild(h("td", null, "T" + r.turn));
      tr.appendChild(h("td", null, Math.round(G.restatement_rate_by_turn[i] * 100) + "%"));
      tr.appendChild(h("td", null, signed(r.with_reference.mean_D, 2) + " (n = " + r.with_reference.n + ")"));
      tr.appendChild(h("td", null, signed(r.without_reference.mean_D, 2) + " (n = " + r.without_reference.n + ")"));
      tbl.appendChild(tr);
    });
    box.replaceChildren(tbl);
    box.appendChild(h("p", "fine", "Post-hoc diagnostic over all 360 workflows, not prespecified. Difference = score with the priority minus the matched no-priority mean, as in the main result. " +
      "From T3 on, the measured difference is larger in texts that restate the priority, so part of what the rater registers may be restatement rather than influence on the advice."));
    var e = G.text_excess_dissimilarity, c = G.text_excess_dissimilarity_T6_minus_T1;
    $("convergence-note").textContent = "A check that uses no rater points the same way: texts written with the priority were more different " +
      "from the matched no-priority texts than those were from each other by " + num(e[0].point, 3) + " at T1 (word-overlap similarity) and by " +
      num(e[5].point, 3) + " at T6 (change " + signed(c.point, 3) + ", 95% CI " + num(c.lo, 3) + " to " + num(c.hi, 3) +
      "). This shows the texts converging, not which values they express. Post-hoc and exploratory.";
  }

  // -------------------------------------------------- minimal text render
  // Generated turns are Markdown-ish. Escape everything, then allow only
  // headings, bold/italic, bullets and rules. No HTML from the data survives.
  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
            .replace(RESTATE, '<mark class="restate">$&</mark>')
            .replace(/\[stated priority\]/g, REDACT_SP)
            .replace(/\[priority wording\]/g, REDACT_PW);
  }
  function markers(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/\[stated priority\]/g, REDACT_SP).replace(/\[priority wording\]/g, REDACT_PW);
  }
  function renderText(raw) {
    var esc = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var out = [], para = [], list = [];
    function flushP() { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } }
    function flushL() { if (list.length) { out.push("<ul>" + list.map(function (li) { return "<li>" + inline(li) + "</li>"; }).join("") + "</ul>"); list = []; } }
    esc.split("\n").forEach(function (line) {
      var t = line.trim(), mm;
      if (!t) { flushP(); flushL(); return; }
      if (/^(\*\s*){3,}$|^-{3,}$/.test(t)) { flushP(); flushL(); out.push("<hr>"); return; }
      if ((mm = t.match(/^#{1,6}\s+(.*)$/))) { flushP(); flushL(); out.push("<h5>" + inline(mm[1]) + "</h5>"); return; }
      if ((mm = t.match(/^[*\-•]\s+(.*)$/))) { flushP(); list.push(mm[1]); return; }
      flushL();
      if (/^\d+[.)]\s+/.test(t)) flushP();
      para.push(t);
    });
    flushP(); flushL();
    return out.join("");
  }
  function loading(node, what) {
    node.replaceChildren(h("p", "loading", "Loading " + what + "…"));
  }
  function failed(node) {
    node.replaceChildren(h("p", "error", "This transcript file could not be loaded. The scores above are unaffected."));
  }

  // ----------------------------------------------------------- stage panel
  function inputBox(t) {
    var T = D.templates, box = $("turn-input");
    box.replaceChildren();
    function block(label, text) {
      box.appendChild(h("p", "lab", label));
      var pre = h("pre", "tmpl");
      pre.innerHTML = markers(text);
      box.appendChild(pre);
    }
    var prev = "[the T" + (t.turn - 1) + " text from the same workflow]";
    if (t.turn === 1) {
      block("With the priority", T.with_priority.advisor.replace("{task}", state.example.situation));
      block("Matched run without a priority (identical, minus the priority lines)",
        T.without_priority.advisor.replace("{task}", state.example.situation));
    } else {
      var key = t.role === "advisor" ? "advisor_continue" : t.role;
      block("Both versions (each receives its own previous text)", T.with_priority[key].replace("{prev}", prev));
    }
    box.appendChild(h("p", "fine", "The build checks that these templates, filled with the saved values, reproduce every stored prompt exactly."));
  }

  function drawStageSummary() {
    var ex = state.example, t = ex.turns[state.turn - 1], box = $("stage-summary");
    var flags = RESTATES[ex.id];
    box.replaceChildren();
    var top = h("p", "ss-top");
    top.appendChild(h("b", null, "T" + t.turn + " · " + (ROLE[t.role] || t.role)));
    if (flags && flags[t.turn - 1]) top.appendChild(h("span", "rs-flag restate-flag", "restates priority"));
    box.appendChild(top);
    var row = h("p", "ss-row");
    row.appendChild(h("span", null, "With the priority " + score(t.anchored)));
    row.appendChild(h("span", null, "Without (mean of 3) " + score(t.reference)));
    row.appendChild(h("span", "ss-d", "Difference " + signed(t.difference, 2)));
    box.appendChild(row);
    if (isCeiling(t)) box.appendChild(h("p", "fine", "Both versions scored +2, the top of the scale, so the difference is 0 by construction, not because the texts were the same."));
    $("stage-details-sum").textContent = "Read the recorded texts, prompts and matched controls for T" + t.turn + " · " + (ROLE[t.role] || t.role);
  }

  function drawPanel() {
    var ex = state.example, t = ex.turns[state.turn - 1];
    drawStageSummary();
    $("turn-h").textContent = "T" + t.turn + " · " + (ROLE[t.role] || t.role);
    $("turn-role-note").textContent = ROLE_NOTE[t.turn];
    $("prev-turn").disabled = state.turn === 1;
    $("next-turn").disabled = state.turn === 6;
    inputBox(t);

    var a = $("anchor-score");
    a.replaceChildren(h("b", null, ex.value + " " + score(t.anchored)),
      document.createTextNode(" · median of the rater's scores " + draws(t.anchored_draws)));
    drawRef(t);

    var at = $("anchor-text");
    loading(at, "text");
    var want = ex.id, wantTurn = state.turn;
    loadText(ex.id, function (obj) {
      if (state.example.id !== want || state.turn !== wantTurn) return;
      var tt = obj.turns[wantTurn - 1];
      at.innerHTML = renderText(tt.text);
      markRestates(ex.id, obj);
      var n = tt.redactions.verbatim + tt.redactions.partial;
      if (n) at.appendChild(h("p", "fine", n + " withheld wording marker" + (n > 1 ? "s" : "") + " in this text."));
    }, function () { failed(at); });
    drawProfile(t);
  }

  function drawRef(t) {
    var tabs = $("run-tabs");
    tabs.replaceChildren();
    [0, 1, 2].forEach(function (i) {
      var b = h("button", "seg-b", "Run " + (i + 1));
      b.type = "button";
      b.setAttribute("aria-pressed", String(i === state.run));
      b.addEventListener("click", function () { state.run = i; drawRef(state.example.turns[state.turn - 1]); });
      tabs.appendChild(b);
    });
    var r = $("ref-score");
    r.replaceChildren(h("b", null, state.example.value + " " + score(t.reference_runs[state.run])),
      document.createTextNode(" in this run · median of " + draws(t.reference_draws[state.run]) +
        " · mean over the 3 runs " + score(t.reference)));
    var rt = $("ref-text");
    loading(rt, "matched text");
    var sid = state.example.scenario_id, want = state.turn, run = state.run;
    loadText("ref-" + sid, function (obj) {
      if (state.example.scenario_id !== sid || state.turn !== want || state.run !== run) return;
      rt.innerHTML = renderText(obj.runs[run].turns[want - 1].text);
    }, function () { failed(rt); });
  }

  function drawProfile(t) {
    var box = $("profile-table"), v = state.example.value;
    var tbl = h("table");
    var hr = h("tr");
    ["Value", "With the priority", "Without (mean of 3)"].forEach(function (c) { hr.appendChild(h("th", null, c)); });
    tbl.appendChild(hr);
    Object.keys(t.profile_anchored).forEach(function (k) {
      var tr = h("tr", k === v ? "focal" : null);
      tr.appendChild(h("td", null, k + (k === v ? " (stated)" : "")));
      tr.appendChild(h("td", null, score(t.profile_anchored[k])));
      tr.appendChild(h("td", null, score(t.profile_reference[k])));
      tbl.appendChild(tr);
    });
    box.replaceChildren(tbl);
  }

  function selectTurn(n) {
    state.turn = n;
    drawExample(); drawScores(); drawPipeline(); drawPanel();
    writeHash();
  }

  // ------------------------------------------------------------ examples
  function byId(id) { return D.examples.filter(function (e) { return e.id === id; })[0]; }

  function selectExample(id, turn) {
    var ex = byId(id);
    state.example = ex; state.turn = turn || 1; state.run = 0;
    $("ex-id").textContent = (ex.core ? "Core example · " : "Extended set · ") + "dilemma " + ex.scenario_id + " · workflow " + ex.id;
    $("ex-value").textContent = "Stated priority: " + ex.value;
    $("ex-desc").textContent = ex.description + ". Exact wording withheld.";
    $("ex-value-name").textContent = ex.value;
    $("ex-situation").textContent = ex.situation;
    Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
      c.setAttribute("aria-pressed", String(ex.core && c.dataset.id === id));
    });
    $("example-select").value = id;
    drawExample(); drawScores(); drawPipeline(); drawPanel();
    writeHash();
  }

  function setSet(which) {
    state.set = which;
    $("set-core").setAttribute("aria-pressed", String(which === "core"));
    $("set-all").setAttribute("aria-pressed", String(which === "all"));
    $("all-wrap").hidden = which !== "all";
  }

  function buildPicker() {
    var chips = $("value-chips"), sel = $("example-select");
    D.examples.filter(function (e) { return e.core; }).forEach(function (e) {
      var c = h("button", "chip", e.value);
      c.type = "button";
      c.dataset.id = e.id;
      c.title = e.description;
      c.addEventListener("click", function () { setSet("core"); selectExample(e.id); });
      chips.appendChild(c);
    });
    D.examples.forEach(function (e) {
      var s = e.situation.split(/\n/)[0];
      var o = h("option", null, e.scenario_id + " · " + e.value + (e.core ? " (core)" : "") + " — " +
        (s.length > 70 ? s.slice(0, 68) + "…" : s));
      o.value = e.id;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { selectExample(sel.value); });
    $("set-core").addEventListener("click", function () {
      setSet("core");
      if (!state.example.core) selectExample(D.examples.filter(function (e) { return e.core; })[0].id);
    });
    $("set-all").addEventListener("click", function () { setSet("all"); sel.focus(); });
    $("prev-turn").addEventListener("click", function () { if (state.turn > 1) selectTurn(state.turn - 1); });
    $("next-turn").addEventListener("click", function () { if (state.turn < 6) selectTurn(state.turn + 1); });
    $("pipeline").addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowRight" && state.turn < 6) { selectTurn(state.turn + 1); focusStage(); ev.preventDefault(); }
      if (ev.key === "ArrowLeft" && state.turn > 1) { selectTurn(state.turn - 1); focusStage(); ev.preventDefault(); }
    });
  }
  function focusStage() {
    var b = document.querySelectorAll("#pipeline .stage")[state.turn - 1];
    if (b) b.focus();
  }

  var hashLock = false;
  var booting = true;   // v2: never overwrite a deep link (e.g. #case/...) while the page boots
  function writeHash() {
    if (!state.example || booting) return;
    var hsh = "#" + state.example.id + "/" + state.turn;
    if (location.hash !== hsh && history.replaceState) { hashLock = true; history.replaceState(null, "", hsh); hashLock = false; }
  }
  function readHash() {
    var link = decodeURIComponent(location.hash.slice(1)).split("/");
    var ex = byId(link[0]);
    if (!ex) return false;
    var lt = Number(link[1]);
    setSet(ex.core ? "core" : "all");
    selectExample(ex.id, lt >= 1 && lt <= 6 ? lt : 1);
    return true;
  }

  // ------------------------------------------------- single-turn study (Study 2)
  // Every number below is counted here from the recorded answers in
  // window.SINGLE_TURN, or read from its frozen analysis; nothing is typed in.
  function pct(x) { return Math.round(x * 100) + "%"; }
  function interval(s) {
    if (!s) return "not available";
    // Bootstrap percentile intervals stay within 0-100%; the prespecified t-intervals
    // (which can exceed 100% at the ceiling) are kept in the study's analysis files.
    if (s.status === "ok") return "95% bootstrap CI " + pct(s.bootstrap_ci95[0]) + " to " + pct(s.bootstrap_ci95[1]);
    if (s.exact_bound_95) return s.status + "; " + s.exact_bound_95;
    return s.status;
  }
  function stCode(d) {
    var parts = d.base_id.split("_"), n = parts.pop();
    return parts.map(function (w) { return w.charAt(0).toUpperCase(); }).join("") + n;
  }
  function stValues(d) { return d.priorities.map(function (p) { return p.focal_value; }); }
  function stPairName(d) { return stValues(d).join(" vs ") ; }
  function ok(r) { return r && r.parsed === r.correct_choice; }
  function orderName(o) { return o === "orig" ? "original order" : "swapped order"; }
  var CLASS_TEXT = {
    stable_substantive: "Stable: the same option in all six no-priority answers, in both orders",
    abstain_or_invalid: "No stable choice: at least one of the six no-priority answers was UNCLEAR",
    inconsistent: "No stable choice: the six no-priority answers chose different options",
    order_dependent: "No stable choice: the answer followed the letter rather than the option"
  };

  function stStats(S) {
    var t = { pr: 0, prN: 0, units: 0, unitsOK: 0, unc: 0, dN: 0, cells: 0, same: 0, byPair: {}, eligible: 0, stable: 0 };
    S.decisions.forEach(function (d) {
      var bp = t.byPair[d.pair] || (t.byPair[d.pair] = { name: stPairName(d), n: 0, unc: 0, dN: 0, pr: 0, prN: 0 });
      bp.n++;
      d.priority_responses.forEach(function (r) { t.prN++; bp.prN++; if (ok(r)) { t.pr++; bp.pr++; } });
      var allOK = true;
      Object.keys(d.orders).forEach(function (o) {
        var rs = d.priority_responses.filter(function (r) { return r.order === o; });
        var both = rs.length === 2 && rs.every(ok);
        t.units++; if (both) t.unitsOK++; else allOK = false;
        var ds = d.default_responses.filter(function (x) { return x.order === o; });
        t.cells++; if (ds.every(function (x) { return x.parsed === ds[0].parsed; })) t.same++;
      });
      d.default_responses.forEach(function (x) { t.dN++; bp.dN++; if (x.parsed === "ABSTAIN") { t.unc++; bp.unc++; } });
      if (d.default_class === "stable_substantive") { t.stable++; if (allOK) t.eligible++; }
    });
    return t;
  }

  function fillStory(S) {
    var r = D.headline.delta_by_turn;
    $("story-s1-n").textContent = signed(r[0].point, 2) + " → " + signed(r[5].point, 2);
    if (!S || S.status !== "complete") {
      $("story-st-n").textContent = "Not yet run";
      $("story-st-sub").textContent = "No verified results are available.";
      return;
    }
    var t = stStats(S);
    $("story-st-n").textContent = t.pr + " / " + t.prN;
  }

  function stKpis(S, t) {
    var P = S.primary, k = h("dl", "kpis st-kpis");
    k.id = "st-kpis";
    [["matched the stated priority", t.pr + " / " + t.prN, ""],
     ["opposing priorities gave opposite choices", t.unitsOK + " / " + t.units, ""],
     ["no-priority answers were UNCLEAR", t.unc + " / " + t.dN, "unc"],
     ["decisions had a stable no-priority choice", t.stable + " / " + P.n_scenarios, ""]
    ].forEach(function (r) {
      var d = h("div", "kpi" + (r[2] ? " kpi-unc" : ""));
      d.appendChild(h("dd", "kpi-n", r[1])); d.appendChild(h("dt", null, r[0]));
      if (r[2]) {
        var bar = h("dd", "unc-bar"); bar.setAttribute("aria-hidden", "true");
        var f = h("span"); f.style.width = (100 * t.unc / t.dN).toFixed(1) + "%"; bar.appendChild(f);
        d.appendChild(bar);
        d.appendChild(h("dd", "kpi-ci", pct(t.unc / t.dN) + ". UNCLEAR was an allowed answer."));
      }
      k.appendChild(d);
    });
    return k;
  }
  function stStatsList(S, t) {
    var P = S.primary, Q = P.Q2_Q3_all, ul = h("ul", "limits"); ul.id = "st-stats";
    [["Priority-consistent choices: " + t.pr + " / " + t.prN + ".", "Per decision " + pct(Q.accuracy.estimate) + "; " + interval(Q.accuracy) + "."],
     ["Paired sensitivity: " + t.unitsOK + " / " + t.units + " decision-orders.", "Per decision " + pct(Q.pair_sensitivity.estimate) + "; " + interval(Q.pair_sensitivity) + "."],
     ["Stable no-priority choices: " + t.stable + " / " + P.n_scenarios + ".", "The same option in all six answers; an observed default under this prompt, not a value."]
    ].forEach(function (r) { var l = h("li"); l.appendChild(h("b", null, r[0] + " ")); l.appendChild(document.createTextNode(r[1])); ul.appendChild(l); });
    ul.appendChild(h("li", "fine", "Unit of inference: the decision (n = " + P.n_scenarios + "). Parser: " + P.parser + ". Source: " + S.source.kit + "/" +
      S.source.run + ", ledger sha256 " + S.source.ledger_sha256.slice(0, 12) + "…"));
    return ul;
  }

  function stUnclear(S, t) {
    var box = h("div", "st-callout"); box.id = "st-unclear";
    box.appendChild(h("p", "lab", "The finding to read first"));
    box.appendChild(h("h3", null, "Without a priority, the model declined to choose in " + pct(t.unc / t.dN) + " of answers."));
    var p = h("p");
    p.textContent = "This is not a failure. The prompt explicitly offered three replies: FIRST CHOICE: A, B or UNCLEAR. " +
      "UNCLEAR is reported as its own outcome, never as a correct choice." +
      (S.primary.abstain.priority === 0 ? " Once a priority was stated, the model never answered UNCLEAR." :
       " With a priority stated, " + S.primary.abstain.priority + " answers were UNCLEAR.");
    box.appendChild(p);
    var p2 = h("p");
    p2.textContent = "Repeatability was limited. The identical no-priority prompt, sent three times at near-greedy settings " +
      "(temperature 0.2, top-k 1), gave the same answer all three times in only " + t.same + " of " + t.cells +
      " decision-orders. So only " + t.stable + " of " + S.decisions.length +
      " decisions had a stable no-priority choice, too few to say which values the model favors by default.";
    box.appendChild(p2);
    var bars = h("div", "st-bars"); bars.setAttribute("role", "table"); bars.setAttribute("aria-label", "UNCLEAR share by value pair");
    Object.keys(t.byPair).sort(function (a, b) { return t.byPair[b].unc / t.byPair[b].dN - t.byPair[a].unc / t.byPair[a].dN; })
      .forEach(function (k) {
        var bp = t.byPair[k], row = h("div", "st-bar"); row.setAttribute("role", "row");
        var name = h("span", "st-bar-name", bp.name); name.setAttribute("role", "rowheader");
        var track = h("span", "st-bar-track"); track.setAttribute("role", "cell");
        var fill = h("span", "st-bar-fill"); fill.style.width = (100 * bp.unc / bp.dN).toFixed(1) + "%";
        track.appendChild(fill);
        var val = h("span", "st-bar-val", bp.unc + " / " + bp.dN + " (" + pct(bp.unc / bp.dN) + ")"); val.setAttribute("role", "cell");
        row.appendChild(name); row.appendChild(track); row.appendChild(val);
        bars.appendChild(row);
      });
    box.appendChild(h("p", "axis-title", "UNCLEAR share of no-priority answers, by value pair"));
    box.appendChild(bars);
    return box;
  }

  function stFindings(S, t) {
    var P = S.primary, box = h("div", "st-findings"); box.id = "st-findings";
    box.appendChild(h("h3", "sub-h", "What the prespecified tests found"));
    var ul = h("ul", "limits");
    function li(head, text) { var l = h("li"); l.appendChild(h("b", null, head + " ")); l.appendChild(document.createTextNode(text)); ul.appendChild(l); }
    var miss = [];
    S.decisions.forEach(function (d) {
      d.priority_responses.forEach(function (r) {
        if (!ok(r)) {
          var got = d.orders[r.order].values[r.parsed];
          miss.push(stCode(d) + " (" + orderName(r.order) + "): a " + r.focal_value + " priority was answered with the " +
            (got || r.parsed) + " option" + (got && got === d.default_value ? ", which was also this decision's stable no-priority choice" : ""));
        }
      });
    });
    var nABPU = ["achievement_benevolence", "power_universalism"].reduce(function (a, k) { return a + (t.byPair[k] ? t.byPair[k].n : 0); }, 0);
    var q4 = P.Q4_counter_default, h1 = P.Q1_defaults.H1_prosocial_default, h2 = P.Q5_H2_prosocial_minus_self_oriented_priority.AB_and_PU;
    li("The single miss.", miss.length ? miss.join("; ") + (miss.length === 1 ? ". It is one observation." : ".") : "None.");
    li("Priority against the default.", "Where a stable default existed, priorities agreeing with it were followed " + q4.with_default_correct +
      " and priorities opposing it " + q4.counter_default_correct + ". With only " + q4.scenarios_with_stable_default +
      " such decisions, the difference (" + num(q4.paired_difference_with_minus_counter.estimate, 2) + ", 95% CI " +
      num(q4.paired_difference_with_minus_counter.t_ci95[0], 2) + " to " + num(q4.paired_difference_with_minus_counter.t_ci95[1], 2) +
      ") cannot be interpreted.");
    li("H1, a prosocial default: not supported.", "It predicted that, with no priority, the model would favor the Benevolence or Universalism option. " +
      "Only " + h1.stable_AB_PU_scenarios + " of those " + nABPU + " decisions had a stable default, and " + h1.prosocial_default +
      " of them were prosocial (95% CI " + pct(h1.clopper_pearson_95[0]) + " to " + pct(h1.clopper_pearson_95[1]) + "): too few to test.");
    li("H2, prosocial priorities followed more often: not supported.", "Difference " + num(h2.estimate, 3) + " (95% CI " +
      num(h2.t_ci95[0], 3) + " to " + num(h2.t_ci95[1], 3) + ", " + h2.n_scenarios +
      " decisions). Achievement and Power priorities were followed as reliably as Benevolence and Universalism priorities.");
    box.appendChild(ul);
    return box;
  }

  function fillOpen(S, t) {
    var node = $("open-deleg");
    if (!S || S.status !== "complete") return;
    var Q = S.primary.Q2_Q3_all;
    node.replaceChildren();
    node.appendChild(document.createTextNode(
      "Before any data were collected, the study plan fixed the criteria a delegation follow-up had to meet. " +
      "The priority had to change single-turn choices reliably: paired sensitivity of at least 75% (observed " + pct(Q.pair_sensitivity.estimate) +
      ", met). And at least 8 decisions needed both perfect paired sensitivity and a stable no-priority choice, so that a later shift " +
      "back toward that choice could be detected. Only " + t.eligible + " qualified, because most no-priority answers were UNCLEAR or varied. " +
      "Single-turn accuracy was also at ceiling, leaving little room to see a delegated decline. So the extension, as designed, did not proceed; " +
      "a delegation study needs a new design, decided separately."));
  }

  function drawSingleTurn() {
    var root = $("st-root"), S = window.SINGLE_TURN;
    root.replaceChildren();
    fillStory(S);
    if (!S || S.status === "pending") {
      root.appendChild(h("p", "badge", "Not yet run"));
      root.appendChild(h("p", null, (S && S.message) || "The single-turn behavioral study has not been run. No results are shown."));
      return;
    }
    if (S.status === "fixture") {
      root.appendChild(h("p", "badge warn", "Test fixture: synthetic responses, not experimental results"));
    } else {
      root.appendChild(h("p", "badge ok", "Completed run · verified against its ledger"));
    }
    var t = stStats(S), P = S.primary, more = $("st-more-body");
    root.appendChild(stKpis(S, t));
    more.replaceChildren(stStatsList(S, t), stUnclear(S, t));
    fillOpen(S, t);

    // ---- the viewer: the decision grid is the primary visual
    var card = h("div", "st-card"); card.id = "st-viewer"; root.appendChild(card);
    var map = h("div", "st-mapbox");
    map.appendChild(h("h3", "sub-h", "All " + S.decisions.length + " decisions · choose one"));
    var legend = h("p", "fine st-legend");
    [["mk ok", "priority followed"], ["mk miss", "not followed"],
     ["mk v1|mk v2", "no-priority choice (colour = value)"], ["mk unc", "UNCLEAR"]].forEach(function (x) {
      var s = h("span", "lg");
      x[0].split("|").forEach(function (c) { s.appendChild(h("span", c)); });
      s.appendChild(document.createTextNode(x[1])); legend.appendChild(s);
    });
    legend.appendChild(h("span", "lg", "Per tile: 4 priority answers | 6 no-priority answers."));
    map.appendChild(legend);
    var groups = {}, tiles = [];
    S.decisions.forEach(function (d, i) {
      if (!groups[d.pair]) {
        var g = h("div", "st-group");
        var gl = h("p", "lab st-glab"), gv = stValues(d);
        gl.appendChild(h("span", "mk v1")); gl.appendChild(document.createTextNode(gv[0] + " vs "));
        gl.appendChild(h("span", "mk v2")); gl.appendChild(document.createTextNode(gv[1] + " · " + t.byPair[d.pair].n + " decisions"));
        g.appendChild(gl);
        groups[d.pair] = h("div", "st-tiles"); g.appendChild(groups[d.pair]); map.appendChild(g);
      }
      var vals = stValues(d), b = h("button", "st-tile"); b.type = "button";
      b.appendChild(h("span", "st-code", stCode(d)));
      b.appendChild(h("span", "st-title", d.title || ""));
      var marks = h("span", "marks"), nOK = 0;
      ["orig", "swap"].forEach(function (o) {
        vals.forEach(function (v) {
          var r = d.priority_responses.filter(function (x) { return x.order === o && x.focal_value === v; })[0];
          if (ok(r)) nOK++;
          marks.appendChild(h("span", "mk " + (ok(r) ? "ok" : "miss")));
        });
      });
      marks.appendChild(h("span", "mk-sep"));
      var tally = {};
      d.default_responses.forEach(function (x) {
        var v = d.orders[x.order].values[x.parsed];
        tally[v || "UNCLEAR"] = (tally[v || "UNCLEAR"] || 0) + 1;
        marks.appendChild(h("span", "mk " + (v === vals[0] ? "v1" : v === vals[1] ? "v2" : "unc")));
      });
      b.appendChild(marks);
      b.setAttribute("aria-label", stCode(d) + ", " + (d.title || "") + ": " + nOK + " of 4 priority choices followed; no priority: " +
        Object.keys(tally).map(function (k) { return k + " " + tally[k]; }).join(", "));
      b.addEventListener("click", function () {
        st.d = i; st.c = "none"; render();
        var hd = body.querySelector(".st-dhead");
        if (hd && hd.scrollIntoView) hd.scrollIntoView({ block: "start" });
      });
      groups[d.pair].appendChild(b); tiles.push(b);
    });
    card.appendChild(map);

    var ctl = h("div", "picker st-ctl");
    var lab = h("label", "more", "Decision ");
    var sel = h("select"); sel.id = "st-decision";
    var og = {};
    S.decisions.forEach(function (d, i) {
      if (!og[d.pair]) { og[d.pair] = document.createElement("optgroup"); og[d.pair].label = stPairName(d); sel.appendChild(og[d.pair]); }
      var o = h("option", null, stCode(d) + " · " + (d.title || d.base_id));
      o.value = String(i); og[d.pair].appendChild(o);
    });
    lab.appendChild(sel); ctl.appendChild(lab);
    var r1 = h("div", "picker-row"), r2 = h("div", "picker-row");
    r1.appendChild(h("span", "picker-lab", "Condition"));
    var cond = h("div", "seg"); cond.id = "st-cond"; cond.setAttribute("role", "group"); cond.setAttribute("aria-label", "Condition");
    r1.appendChild(cond);
    r2.appendChild(h("span", "picker-lab", "Option order"));
    var ord = h("div", "seg"); ord.id = "st-order"; ord.setAttribute("role", "group"); ord.setAttribute("aria-label", "Option order");
    r2.appendChild(ord);
    ctl.appendChild(r1); ctl.appendChild(r2);
    card.appendChild(ctl);
    var body = h("div", "st-body"); card.appendChild(body);
    var st = { d: 0, c: "none", o: "orig" };

    function seg(box, items, cur, on) {
      box.replaceChildren();
      items.forEach(function (it) {
        var b = h("button", "seg-b", it[1]); b.type = "button";
        b.setAttribute("aria-pressed", String(it[0] === cur));
        b.addEventListener("click", function () { on(it[0]); });
        box.appendChild(b);
      });
    }
    function optionCards(d, o, chosen, mode) {
      var wrap = h("div", "st-opts"), vals = stValues(d);
      ["A", "B"].forEach(function (L) {
        var v = d.orders[o].values[L];
        var c = h("div", "st-opt " + (v === vals[0] ? "v1" : "v2") + (chosen === L ? " chosen" : ""));
        var top = h("p", "st-opt-top");
        top.appendChild(h("span", "st-letter", L));
        top.appendChild(h("span", "st-vtag", v + " option"));
        if (chosen === L) top.appendChild(h("span", "st-pick", mode));
        c.appendChild(top);
        c.appendChild(h("p", null, d.orders[o].options[L]));
        wrap.appendChild(c);
      });
      return wrap;
    }
    function promptBox(d, o, pri) {
      var T = S.prompt_template, opts = d.orders[o].options;
      var det = h("details", "input-box st-prompt");
      det.appendChild(h("summary", null, "Exact prompt sent to the model"));
      det.appendChild(h("div", "tmpl", T.intro + "TASK: " + d.task + "\nOPTION A: " + opts.A + "\nOPTION B: " + opts.B + "\n" +
        (pri ? "USER PRIORITY: " + pri.text + "\n" : "") + T.instruction));
      return det;
    }
    function answerText(r) { var p = h("div", "resp"); p.textContent = r.text; return p; }
    function choiceLabel(d, x) {
      if (x.parsed === "ABSTAIN") return "UNCLEAR (declined to choose)";
      if (x.parsed === "A" || x.parsed === "B") return x.parsed + ": " + d.orders[x.order].values[x.parsed] + " option";
      return "not parseable";
    }

    function render() {
      var d = S.decisions[st.d], vals = stValues(d);
      sel.value = String(st.d);
      tiles.forEach(function (b, i) { b.setAttribute("aria-pressed", String(i === st.d)); });
      seg(cond, [["none", "No priority"]].concat(d.priorities.map(function (p) { return [p.focal_value, "Priority: " + p.focal_value]; })),
        st.c, function (c) { st.c = c; render(); });
      seg(ord, [["orig", "Original order"], ["swap", "Swapped order"]], st.o, function (o) { st.o = o; render(); });
      body.replaceChildren();
      var head = h("div", "st-dhead");
      head.appendChild(h("p", "eyebrow", stCode(d) + " · " + stPairName(d) + " · " + orderName(st.o)));
      head.appendChild(h("h4", "st-dtitle", d.title || d.base_id));
      head.appendChild(h("p", null, d.task));
      body.appendChild(head);
      var other = st.o === "orig" ? "swap" : "orig";

      if (st.c === "none") {
        body.appendChild(optionCards(d, st.o, null));
        body.appendChild(promptBox(d, st.o, null));
        body.appendChild(h("p", "lab", "Three recorded answers with no priority (" + orderName(st.o) + ")"));
        var reps = h("div", "st-reps");
        d.default_responses.filter(function (x) { return x.order === st.o; }).forEach(function (x) {
          var v = d.orders[x.order].values[x.parsed];
          var c = h("div", "st-rep " + (v === vals[0] ? "v1" : v === vals[1] ? "v2" : "unc"));
          c.appendChild(h("p", "st-rep-h", "Repetition " + x.rep + " · " + choiceLabel(d, x)));
          if (x.text != null) c.appendChild(answerText(x)); else c.appendChild(h("p", "error", "No completed response."));
          reps.appendChild(c);
        });
        body.appendChild(reps);
        var tally = {};
        d.default_responses.forEach(function (x) {
          var k = d.orders[x.order].values[x.parsed] ? d.orders[x.order].values[x.parsed] + " option" : "UNCLEAR";
          tally[k] = (tally[k] || 0) + 1;
        });
        var sum = h("div", "st-verdict neutral");
        sum.appendChild(h("p", null, "All six no-priority answers (both orders): " +
          Object.keys(tally).sort().map(function (k) { return k + " × " + tally[k]; }).join(", ") + "."));
        sum.appendChild(h("p", null, (CLASS_TEXT[d.default_class] || ("Class: " + d.default_class)) +
          (d.default_value ? " (" + d.default_value + " option)." : ".")));
        sum.appendChild(h("p", "fine", "No average is shown, and no default is inferred where the answers disagree. A stable choice is observed behavior under this prompt and these settings, not the model's values."));
        body.appendChild(sum);
        return;
      }

      var p = d.priorities.filter(function (x) { return x.focal_value === st.c; })[0];
      var r = d.priority_responses.filter(function (x) { return x.order === st.o && x.focal_value === p.focal_value; })[0];
      var ro = d.priority_responses.filter(function (x) { return x.order === other && x.focal_value === p.focal_value; })[0];
      var q = h("div", "st-priority");
      q.appendChild(h("p", "lab", "The user's stated priority"));
      q.appendChild(h("p", "quote", p.text));
      body.appendChild(q);
      body.appendChild(optionCards(d, st.o, r && r.text != null ? r.parsed : null, "recommended"));
      body.appendChild(promptBox(d, st.o, p));
      if (!r || r.text == null) { body.appendChild(h("p", "error", "No completed response for this condition (technical failure).")); return; }
      var v = h("div", "st-verdict " + (ok(r) ? "match" : "nomatch"));
      v.appendChild(h("p", "st-verdict-h", ok(r) ? "Matches the stated priority" : "Does not match the stated priority"));
      v.appendChild(h("p", null, "Recommended option " + r.parsed + " (" + (d.orders[st.o].values[r.parsed] || "no option") +
        "). The option that matches a " + p.focal_value + " priority is " + r.correct_choice + "."));
      if (ro && ro.text != null) {
        var same = d.orders[other].values[ro.parsed] === d.orders[st.o].values[r.parsed];
        v.appendChild(h("p", "fine", "In the " + orderName(other) + ", the same priority led to option " + ro.parsed + ", the " +
          (d.orders[other].values[ro.parsed] || "?") + " option" + (same ? ": the same option under a different letter." : ": a different option.")));
      }
      body.appendChild(v);
      body.appendChild(h("p", "lab", "Full recorded answer"));
      body.appendChild(answerText(r));
    }
    sel.addEventListener("change", function () { st.d = Number(sel.value); st.c = "none"; render(); });
    render();
    more.appendChild(stFindings(S, t));
  }

  // ---------------------------------------------------------------- boot
  function redraw() { drawHeadline(); if (state.example) drawExample(); }
  // charts inside a closed disclosure have no width; draw them when opened
  $("ex-more").addEventListener("toggle", function () { if (this.open && state.example) drawExample(); });
  buildPicker();
  drawKpis();
  drawDiagnostics();
  headlineCaption();
  drawHeadline();
  if (!readHash()) selectExample(D.examples.filter(function (e) { return e.core; })[0].id);
  drawSingleTurn();
  booting = false;
  window.addEventListener("hashchange", function () { if (!hashLock) readHash(); });

  var pending = null, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(pending);
    pending = setTimeout(redraw, 120);
  });
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", redraw);
  }
})();
