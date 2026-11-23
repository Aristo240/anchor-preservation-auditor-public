// Recorded experiment walkthrough (Study 3B). Every number, choice and text comes from window.STUDY3B and the
// per-case text files assets/s3b/<id>.js (built by auditor/build_study3b_showcase.py from the verified records).
// Model text is rendered with textContent only. Nothing runs live; this is a replay of saved outputs.
// Addresses: #replay/<case id> (start of the walkthrough), #case/<case id>[/<condition>] (everything revealed).
(function () {
  "use strict";
  var S = window.STUDY3B; if (!S) return;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return arguments[arguments.length - 1]; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  // v4 review fix (focus): a control that rebuilds its own group would leave keyboard focus on <body>; put it back on
  // the control now at the same place in the rebuilt group.
  function stay(b, fn) {
    return function (e) {
      var box = b.parentNode, i = box ? Array.prototype.indexOf.call(box.children, b) : -1, had = document.activeElement === b;
      fn(e);
      if (had && !b.isConnected && box && box.isConnected && (!document.activeElement || document.activeElement === document.body)) {
        var n = box.children[i]; if (n && n.focus) n.focus();
      }
    };
  }
  function btn(cls, text, fn) { var b = h("button", cls, text); b.type = "button"; b.addEventListener("click", stay(b, fn)); return b; }
  function words(t) { return t.trim().split(/\s+/).length; }
  function opening(t) { var s = t.replace(/\s+/g, " ").trim(); if (s.length <= 260) return s; s = s.slice(0, 260); return s.slice(0, s.lastIndexOf(" ")) + " …"; }

  var BY = {}; S.cases.forEach(function (c) { BY[c.id] = c; });
  var SCEN = []; S.cases.forEach(function (c) { if (SCEN.indexOf(c.scenario) < 0) SCEN.push(c.scenario); });
  function caseOf(scen, order, pidx) { return BY[scen + "_" + order + "_" + pidx]; }
  var ROLE = ["advisor", "critic", "summarizer", "advisor", "critic", "summarizer"];
  var OC = { matched: "✓ The option built to fit the priority", opposite: "⇄ The other option", unclear: "? Declined to choose (UNCLEAR)" };
  var CH = { A: "Option A", B: "Option B", UNCLEAR: "Declined to choose", ABSTAIN: "Declined to choose" };
  var PREV = "{{PREVIOUS_STAGE}}", HANDOFF = "{{T6_HANDOFF}}";

  // ---------------------------------------------------------------- recorded texts, loaded on demand
  var TEXT = {}, wait = {};
  window.__s3bText = function (t) { TEXT[t.id] = t; (wait[t.id] || []).forEach(function (f) { f(t); }); delete wait[t.id]; };
  function text(id, f) {
    if (TEXT[id]) { f(TEXT[id]); return; }
    if (wait[id]) { wait[id].push(f); return; }
    wait[id] = [f];
    var s = document.createElement("script"); s.src = "assets/s3b/" + encodeURIComponent(id) + ".js";
    s.onerror = function () { $("hp").textContent = "The recorded texts for this case could not be loaded."; };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- state
  var st = { c: BY[S.selection.opening_case], step: 0, sel: 0 };

  // ---------------------------------------------------------------- picker
  function drawPicker(note) {
    var c = st.c, dc = clear($("dcards"));
    SCEN.forEach(function (sc) {
      var any = caseOf(sc, "orig", "p0"), b = btn("dcard", null, function () { load(caseOf(sc, st.c.order, st.c.priority_index), "Loaded a different decision."); });
      add(b, h("span", null, any.title)); add(b, h("small", null, any.pair_label));
      var dots = add(b, h("span", "dots")); dots.setAttribute("aria-hidden", "true");
      ["orig", "swap"].forEach(function (o) { ["p0", "p1"].forEach(function (p) { add(dots, h("i", "bg-" + caseOf(sc, o, p).outcomes.delegated)); }); });
      b.setAttribute("aria-pressed", sc === c.scenario ? "true" : "false");
      b.setAttribute("aria-label", any.title + ", " + any.pair_label);
      dc.appendChild(b);
    });
    var pr = clear($("pris"));
    ["p0", "p1"].forEach(function (p) {
      var x = caseOf(c.scenario, c.order, p);
      var b = btn("pri", null, function () { if (p !== c.priority_index) load(x, "Loaded the separately recorded run for this priority: its own six handoffs and final decisions. Nothing was edited."); });
      add(b, h("b", null, x.focal_value + " first")); add(b, h("span", null, x.priority));
      b.setAttribute("aria-pressed", p === c.priority_index ? "true" : "false");
      pr.appendChild(b);
    });
    var od = clear($("orders"));
    [["orig", "As built"], ["swap", "Options swapped"]].forEach(function (o) {
      var b = btn("chip", o[1], function () { if (o[0] !== c.order) load(caseOf(c.scenario, o[0], c.priority_index), "Loaded the separately recorded run with the options in the other order."); });
      b.setAttribute("aria-pressed", o[0] === c.order ? "true" : "false"); od.appendChild(b);
    });
    $("switched").textContent = note || "";
    $("run-id").textContent = "Run ID: " + c.id + " · option order: " + (c.order === "orig" ? "as built" : "swapped");
    $("c-label").textContent = c.id === S.selection.opening_case ? S.selection.opening_label : "";
  }
  var FINDS = [["opposite", "No reminder: chose the other option"], ["unclear", "No reminder: didn't choose"], ["matched", "Matched with and without the reminder"]];
  function drawFinds(active) {
    var f = clear($("finds"));
    FINDS.forEach(function (x) {
      var n = S.cases.filter(function (c) { return c.outcomes.delegated === x[0]; }).length;
      var b = btn("chip", null, function () { drawFinds(active === x[0] ? null : x[0]); });
      add(b, document.createTextNode(x[1])); add(b, h("span", "ct", "· " + n));
      b.setAttribute("aria-pressed", active === x[0] ? "true" : "false"); f.appendChild(b);
    });
    var l = clear($("findlist"));
    if (!active) return;
    S.cases.filter(function (c) { return c.outcomes.delegated === active; }).forEach(function (c) {
      var li = add(l, h("li"));
      add(li, btn(null, c.title + " · " + c.focal_value + " first · " + (c.order === "orig" ? "as built" : "options swapped"), function () { load(c, "Loaded a case from the list."); window.scrollTo(0, 0); }));
    });
  }

  // ---------------------------------------------------------------- setup and sequence
  function drawSetup() {
    var c = st.c;
    $("c-pri").textContent = "“" + c.priority + "”";
    $("c-task").textContent = "Task: " + c.task;
    var o = clear($("c-opts"));
    ["A", "B"].forEach(function (k) {
      var d = add(o, h("div", "optc" + (k === c.target ? " fit" : "")));
      add(d, h("b", null, k)); add(d, document.createTextNode(c.options[k]));
      if (k === c.target) add(d, h("span", "fitlab", "Built to fit this priority"));
    });
  }
  function drawSeq() {
    var q = clear($("seq"));
    var labels = [["U", "User"]].concat(ROLE.map(function (r, i) { return [String(i + 1), r]; })).concat([["F", "Final"]]);
    labels.forEach(function (l, i) {
      var state = i > st.step ? "locked" : i === st.sel ? "current" : "done";
      var b = h("button", "sn" + (i === 0 ? " user" : i === 7 ? " final" : "")); b.type = "button";
      b.setAttribute("data-state", state); b.setAttribute("data-i", String(i));
      add(b, h("span", "c", l[0])); add(b, h("span", "sn-l", l[1]));
      if (i === 1) add(b, h("span", "pri-in", "+ priority"));
      b.setAttribute("aria-label", (i === 0 ? "The user's request" : i === 7 ? "The final decision" : "Handoff " + i + ", " + l[1]) + (state === "locked" ? ", not yet revealed" : ""));
      if (i === st.sel) b.setAttribute("aria-current", "step");
      if (state === "locked") b.disabled = true; else b.addEventListener("click", stay(b, function () { st.sel = i; render(false); }));
      q.appendChild(b);
    });
    var cur = q.querySelector("[aria-current]");   // keep the current step in view on narrow screens
    if (cur && q.scrollWidth > q.clientWidth) q.scrollLeft = cur.offsetLeft - q.clientWidth / 2 + cur.offsetWidth / 2;
    var nx = $("next");
    nx.hidden = st.step >= 7;
    nx.textContent = st.step === 0 ? "Start: handoff 1" : st.step < 6 ? "Next: handoff " + (st.step + 1) : "Reveal the final decision";
    $("skip").hidden = st.step >= 7;
    $("restart").hidden = st.step === 0;
  }
  function drawPanel(t) {
    var p = clear($("hp")), c = st.c, i = st.sel;
    if (i === 0) {
      var hd = add(p, h("div", "hp-h")); add(hd, h("h3", null, "The user's request"));
      add(p, h("p", null, "Handoff 1 (advisor) received the task, the two options and the user's priority. Every later handoff saw only the previous handoff's text, and the final-decision call saw only handoff 6."));
      if (t) prompt(p, "Exact prompt for handoff 1", t.chain_prompts[0], "");
      return;
    }
    if (i === 7) {
      var hf = add(p, h("div", "hp-h")); add(hf, h("h3", null, "The final decision"));
      add(p, h("p", null, "A separate call to the same model received the task, the two options and handoff 6, and had to start its answer with FIRST CHOICE: A, B or UNCLEAR. Its recorded answers are below."));
      return;
    }
    var hh = add(p, h("div", "hp-h")); add(hh, h("h3", null, "Handoff " + i + " · " + ROLE[i - 1]));
    if (!t) { add(p, h("p", "meta", "Loading the recorded text…")); return; }
    var tx = t.chain[i - 1];
    add(hh, h("span", "meta", "Received: " + (i === 1 ? "the user's request, including the priority" : "only handoff " + (i - 1) + "'s text") + " · " + words(tx) + " words"));
    var ex = add(p, h("div", "excerpt")); add(ex, h("span", "k", "Opening lines · verbatim, line breaks removed")); add(ex, h("span", null, opening(tx)));
    if (i === 6) add(p, h("p", "fine", "Contains the word “" + c.focal_value + "”: " + (c.t6_names_value && c.t6_names_value.delegated ? "yes" : "no") + ". A literal word match, not a reading of meaning or a predictor of the choice."));
    var d = add(p, h("details", "more")); add(d, h("summary", null, "Read the full text of handoff " + i)); add(d, h("div", "text-box", tx));
    prompt(p, "Exact prompt for handoff " + i, t.chain_prompts[i - 1], i > 1 ? PREV + " stands for the full text of handoff " + (i - 1) + ", inserted verbatim." : "");
  }
  function prompt(parent, label, text, note) {
    var d = add(parent, h("details", "more")); add(d, h("summary", null, label));
    if (note) add(d, h("p", "fine", note));
    add(d, h("pre", "text-box mono", text));
  }

  // ---------------------------------------------------------------- final decisions
  function tile(el, choice, outcome) {
    el.setAttribute("data-outcome", outcome);
    el.querySelector(".ch").textContent = CH[choice] || choice;
    el.querySelector(".opt").textContent = st.c.options[choice] || "";
    el.querySelector(".oc").textContent = OC[outcome];
  }
  function verdict() {
    var c = st.c, d = c.outcomes.delegated, r = c.outcomes.restored;
    var W = { matched: "chose the option built to fit the priority", opposite: "chose the other option", unclear: "declined to choose" };
    if (d === r) return "Recorded: both final decisions " + W[d] + "; repeating the priority didn't change the choice in this run.";
    return "Recorded: without a priority reminder, the final decision " + W[d] + "; with the priority repeated over the same handoff 6, it " + W[r] + ".";
  }
  function drawFinals(t) {
    var c = st.c, show = st.step >= 7;
    $("finals").hidden = !show;
    if (!show) return;
    tile($("f-a"), c.choices.delegated, c.outcomes.delegated);
    var b = $("f-b"), rev = st.step >= 8;
    b.querySelector(".ch").hidden = b.querySelector(".opt").hidden = b.querySelector(".oc").hidden = !rev;
    $("reveal-b").hidden = rev;
    if (rev) { tile(b, c.choices.restored, c.outcomes.restored); b.setAttribute("data-changed", c.outcomes.delegated !== c.outcomes.restored ? "yes" : "no"); }
    else { b.removeAttribute("data-outcome"); }
    $("verdict").textContent = rev ? verdict() : "";
    var fa = clear($("f-answers-in"));
    if (!t) return;
    [["delegated", "No reminder · handoff 6 only"], ["restored", "Same handoff 6 + priority repeated"]].forEach(function (x) {
      if (x[0] === "restored" && !rev) return;
      var box = add(fa, h("div", "cond")); box.id = "cond-" + x[0];
      add(box, h("span", "k", x[1])); add(box, h("div", "text-box", t.decisions[x[0]].text));
      prompt(box, "Exact final-decision prompt", t.decisions[x[0]].prompt, HANDOFF + " stands for handoff 6, inserted verbatim." + (x[0] === "restored" ? " The only difference from the other prompt is the USER PRIORITY line." : ""));
    });
  }
  function drawOther(t) {
    var o = clear($("other-in")), c = st.c;
    if (!t) { add(o, h("p", "muted", "Loading…")); return; }
    var g = add(o, h("div", "cond-grid"));
    var dir = add(g, h("div", "cond")); dir.id = "cond-direct";
    add(dir, h("span", "k", "Told directly · no handoffs")); add(dir, h("p", null, CH[c.choices.direct] + " · " + OC[c.outcomes.direct]));
    add(dir, h("p", "fine", "The final decision received the task, the options and the priority, with no handoffs."));
    var dd = add(dir, h("details", "more")); add(dd, h("summary", null, "Answer and prompt")); add(dd, h("div", "text-box", t.decisions.direct.text)); add(dd, h("pre", "text-box mono", t.decisions.direct.prompt));
    var np = add(g, h("div", "cond")); np.id = "cond-no_priority";
    add(np, h("span", "k", "No priority at all · baseline")); add(np, h("p", null, CH[c.no_priority_choice] || c.no_priority_choice));
    add(np, h("p", "fine", "The task and options only, recorded once per decision and option order. Not compared with a target."));
    var nd = add(np, h("details", "more")); add(nd, h("summary", null, "Answer and prompt")); add(nd, h("div", "text-box", t.no_priority.text)); add(nd, h("pre", "text-box mono", t.no_priority.prompt));
    var ra = add(o, h("div", "cond")); ra.id = "cond-reanchored";
    add(ra, h("span", "k", "Priority re-added at step 4 · newly generated handoffs"));
    add(ra, h("p", "warn", "Not a final-prompt comparison. Handoffs 1–3 are the same saved texts; handoff 4 was newly generated with the priority inserted, and handoffs 5–6 were newly generated after it. The final decision received this new handoff 6, but not the priority as a separate instruction. Its difference from “handoff only” mixes the inserted priority with ordinary run-to-run variation."));
    add(ra, h("p", null, "Recorded final decision: " + CH[c.choices.reanchored] + " · " + OC[c.outcomes.reanchored]));
    add(ra, h("p", "fine", "New handoff 6 contains the word “" + c.focal_value + "”: " + (c.t6_names_value && c.t6_names_value.reanchored ? "yes" : "no") + " (literal word match)."));
    t.reanchor.forEach(function (tx, j) {
      var d = add(ra, h("details", "more")); add(d, h("summary", null, "New handoff " + (j + 4) + " · " + ROLE[j + 3] + " · " + words(tx) + " words"));
      add(d, h("div", "text-box", tx));
      add(d, h("p", "fine", PREV + " stands for " + (j === 0 ? "the saved handoff 3" : "new handoff " + (j + 3)) + ", inserted verbatim."));
      add(d, h("pre", "text-box mono", t.reanchor_prompts[j]));
    });
    var rd = add(ra, h("details", "more")); add(rd, h("summary", null, "Final answer and prompt")); add(rd, h("div", "text-box", t.decisions.reanchored.text));
    add(rd, h("p", "fine", HANDOFF + " stands for the new handoff 6.")); add(rd, h("pre", "text-box mono", t.decisions.reanchored.prompt));
  }

  // ---------------------------------------------------------------- render, navigation, addresses
  function render(scroll) {
    drawSeq(); drawFinals(TEXT[st.c.id]);
    text(st.c.id, function (t) { if (t.id === st.c.id) { drawPanel(t); drawFinals(t); if ($("other").open) drawOther(t); } });
    drawPanel(TEXT[st.c.id]);
    if (scroll && st.step >= 7) $("finals").scrollIntoView({ block: "nearest" });
  }
  function setHash(kind) { var hsh = "#" + kind + "/" + st.c.id; if (location.hash !== hsh && history.replaceState) history.replaceState(null, "", hsh); }
  function load(c, note, opts) {
    opts = opts || {};
    st.c = c; st.step = opts.all ? 8 : 0; st.sel = opts.all ? 7 : 0;
    drawPicker(note); drawSetup();
    $("other").open = !!opts.cond && opts.cond !== "delegated" && opts.cond !== "restored";
    $("f-answers").open = !!opts.all && (opts.cond === "delegated" || opts.cond === "restored");
    render(false);
    if ($("other").open) text(c.id, drawOther);
    setHash(opts.all ? "case" : "replay");
    if (opts.cond) text(c.id, function () { setTimeout(function () { var el = $("cond-" + opts.cond); if (el) el.scrollIntoView({ block: "start" }); }, 0); });
  }
  $("next").addEventListener("click", function () { st.step = Math.min(7, st.step + 1); st.sel = st.step; render(true); if (st.step === 7) $("fin-h").focus && $("finals").scrollIntoView({ block: "nearest" }); });
  $("skip").addEventListener("click", function () { st.step = 7; st.sel = 7; render(true); });
  $("restart").addEventListener("click", function () { st.step = 0; st.sel = 0; render(false); $("seq").scrollIntoView({ block: "nearest" }); });
  $("reveal-b").addEventListener("click", function () { st.step = 8; render(true); $("verdict").focus && $("verdict").setAttribute("tabindex", "-1"); $("verdict").focus(); });
  $("other").addEventListener("toggle", function () { if ($("other").open) text(st.c.id, drawOther); });
  function fromHash() {
    var m = /^#(replay|case)\/([\w-]+)(?:\/(\w+))?$/.exec(location.hash);
    if (m && BY[m[2]]) { load(BY[m[2]], "", { all: m[1] === "case", cond: m[3] }); return true; }
    return false;
  }
  window.addEventListener("hashchange", fromHash);
  if (!fromHash()) load(st.c, "");
  drawFinds(null);

  // ---------------------------------------------------------------- the visitor's own reading: a local export
  $("j-export").addEventListener("click", function () {
    var c = st.c, j = document.querySelector('input[name="j-matter"]:checked');
    var doc = document.implementation.createHTMLDocument("Recorded case and my reading");
    var meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.insertBefore(meta, doc.head.firstChild);
    function e(tag, t) { var n = doc.createElement(tag); n.textContent = t; doc.body.appendChild(n); return n; }
    e("h1", "Recorded case and my reading");
    e("h2", "1. Recorded evidence");
    e("p", "Replay of saved outputs from the Study 3B development pilot (Gemini 2.5 Pro). Run ID: " + c.id + ". Nothing was run live.");
    e("p", "User's priority: “" + c.priority + "”");
    e("p", "Option A: " + c.options.A); e("p", "Option B: " + c.options.B);
    e("p", "Option built to fit the priority: Option " + c.target);
    e("p", "Final decision without a reminder (handoff only): " + CH[c.choices.delegated] + " (" + OC[c.outcomes.delegated].slice(2) + ")");
    e("p", "Final decision with the priority repeated over the same handoff 6: " + CH[c.choices.restored] + " (" + OC[c.outcomes.restored].slice(2) + ")");
    e("h2", "2. My reading (written by me; not checked or interpreted by the site)");
    e("p", "Does the difference matter for this decision? " + (j ? j.value : "Not answered"));
    e("p", "What I would want the AI to clarify or reconsider: " + ($("j-clarify").value.trim() || "(nothing written)"));
    var css = "body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;background:#0b1020;color:#e8edf7}h2{color:#67e8f9;font-size:1.1rem;margin-top:22px}";
    var html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace("</head>", "<style>" + css + "</style></head>");
    var url = URL.createObjectURL(new Blob([html], { type: "text/html" })), a = document.createElement("a");
    a.href = url; a.download = "replay-judgment-" + c.id + ".html"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    $("j-msg").textContent = "Saved replay-judgment-" + c.id + ".html.";
  });
})();
