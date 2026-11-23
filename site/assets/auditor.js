// Be the Auditor: three moves over recorded Study 3B cases (predict, test an intervention, flip the priority).
// Every choice, text and count comes from window.STUDY3B and the per-case text files assets/s3b/<id>.js (built by
// auditor/build_study3b_showcase.py from the verified records). Model text is rendered with textContent only.
// Nothing runs live. Predictions are kept in page memory only: never stored, never sent.
// Entry: the visitor picks a value conflict and which priority should matter more; that loads the separately recorded
// run for that priority (options in their original order). No new output is generated and the pick is not stored.
// Address: auditor.html#<case id> starts that case at Move 1.
(function () {
  "use strict";
  var S = window.STUDY3B, CORE = window.__v3core; if (!S) return;
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
  function opening(t, n) { var s = t.replace(/\s+/g, " ").trim(); if (s.length <= n) return s; s = s.slice(0, n); return s.slice(0, s.lastIndexOf(" ")) + " …"; }

  var BY = {}; S.cases.forEach(function (c) { BY[c.id] = c; });
  function flipOf(c) { return BY[c.scenario + "_" + c.order + "_" + (c.priority_index === "p0" ? "p1" : "p0")]; }
  var CH = { A: "Option A", B: "Option B", ABSTAIN: "No choice (UNCLEAR)" };
  var OC = { matched: "Fits the person's priority", opposite: "The other option", unclear: "Didn't choose: UNCLEAR, not the other option" };
  var IV = {
    restored: { name: "the priority repeated at the final decision", key: "Same handoff 6 + one line with the priority", short: "Repeated at the final decision" },
    reanchored: { name: "the priority re-added at handoff 4", key: "New handoffs 4–6, then the final step", short: "Re-added at handoff 4" }
  };
  var OC1 = { matched: "Fits the first priority", opposite: "Doesn't fit the first priority", unclear: "Didn't choose (UNCLEAR)" };
  var OCF = { matched: "Fits the opposite priority", opposite: "Doesn't fit the opposite priority", unclear: "Didn't choose (UNCLEAR)" };
  var PREV = "{{PREVIOUS_STAGE}}", HANDOFF = "{{T6_HANDOFF}}";

  // Additional cases, fixed by rule (recomputed by the acceptance test): for each outcome of the handoff-only final
  // decision, in the order opposite, matched, UNCLEAR, the case with the smallest sha256("be-the-auditor|" + case id),
  // skipping decisions already shown (the opening case's decision first).
  var EXTRA = [["opposite", "self_direction_tradition_03_orig_p0", "Chose the other option"],
               ["matched", "security_stimulation_10_swap_p1", "Chose the option that fits"],
               ["unclear", "security_stimulation_09_swap_p1", "Didn't make a choice"]];
  var EXTRA_RULE = "How these cases were picked: for each kind of outcome without a reminder (the other option, the fitting option, no choice), the case with the smallest SHA-256 of “be-the-auditor|” + its case ID, skipping decisions already shown. The opening case is the site's fixed-rule example (" + S.selection.opening_rule + ").";

  // ---------------------------------------------------------------- recorded texts, loaded on demand
  var TEXT = {}, wait = {};
  window.__s3bText = function (t) { TEXT[t.id] = t; (wait[t.id] || []).forEach(function (f) { f(t); }); delete wait[t.id]; };
  function text(id, f) {
    if (TEXT[id]) { f(TEXT[id]); return; }
    if (wait[id]) { wait[id].push(f); return; }
    wait[id] = [f];
    var s = document.createElement("script"); s.src = "assets/s3b/" + encodeURIComponent(id) + ".js";
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- state (page memory only)
  var st = { c: BY[S.selection.opening_case], hist: [], seen: [], p1: undefined, p3: undefined };
  var tally = [];   // {case, move, predicted, actual}: a local descriptive count, cleared when the tab closes

  // ---------------------------------------------------------------- screens and navigation
  var SCREENS = ["s-intro", "s-choose", "s-story", "s-m1", "s-m1r", "s-m2", "s-m2r", "s-m3", "s-m3r", "s-end"];
  var STEPS = ["Predict", "Reminder", "Optional: flip", "Takeaway"];
  var cur = "s-intro";
  function show(id, push) {
    if (push === true || (push == null && id !== cur)) st.hist.push(cur);
    cur = id;
    SCREENS.forEach(function (s) { var el = $(s); el.hidden = s !== id; el.classList.remove("enter"); });
    var el = $(id);
    void el.offsetWidth; el.classList.add("enter");
    var step = +el.getAttribute("data-step"), ol = clear($("bta-steps"));
    STEPS.forEach(function (t, i) {
      var li = add(ol, h("li", null, t));
      if (i + 1 === step) li.setAttribute("aria-current", "step"); else if (i + 1 < step) li.className = "done";
    });
    ol.hidden = step === 0;
    if (id === "s-m1") stripPos();
    var hd = el.querySelector("h2"); if (hd && push !== "init") hd.focus({ preventScroll: true });
    var top = $("main").getBoundingClientRect().top + window.scrollY - 8;
    if (window.scrollY > top) window.scrollTo(0, top);
  }
  function back() { if (st.hist.length) show(st.hist.pop(), false); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-back]"), function (b) { b.addEventListener("click", back); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-skipto]"), function (b) { b.addEventListener("click", function () { drawM3(); show(b.getAttribute("data-skipto")); }); });
  // Default path (about two minutes): predict -> reveal -> the final-step reminder -> takeaway. Choosing a test,
  // the handoff-4 test and the flip stay available as optional exploration from the reminder result.
  var NEXT = { "s-m1r": function () { st.p2 = null; drawM2(); drawM2r("restored"); show("s-m2r"); }, "s-m2r": function () { drawEnd(); show("s-end"); }, "s-m3r": function () { drawEnd(); show("s-end"); } };
  $("go-flip").addEventListener("click", function () { drawM3(); show("s-m3"); });
  $("go-tests").addEventListener("click", function () { drawM2(); show("s-m2"); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-next]"), function (b) {
    b.addEventListener("click", function () { NEXT[b.closest(".bta-screen").id](); });
  });

  // ---------------------------------------------------------------- shared pieces
  function tile(el, c, cond) {
    var ch = c.choices[cond], oc = c.outcomes[cond];
    el.setAttribute("data-outcome", oc);
    el.querySelector(".ch").textContent = CH[ch];
    el.querySelector(".opt").textContent = c.options[ch] || "The answer began FIRST CHOICE: UNCLEAR.";
    el.querySelector(".oc").textContent = OC[oc];
  }
  function guessButtons(box, items, onPick) {
    clear(box);
    items.forEach(function (it) {
      var b = add(box, btn("gbtn", null, function () { onPick(it[0]); }));
      add(b, h("b", null, it[1])); if (it[2]) add(b, h("span", null, it[2])); if (it[3]) add(b, h("span", "fitlab", it[3]));
      b.setAttribute("data-choice", it[0]);
    });
  }
  function youLine(pred, actual) {
    if (pred == null) return "You skipped the prediction.";
    return "You predicted: " + CH[pred] + ". Recorded: " + CH[actual] + ". " + (pred === actual ? "Your prediction matched the recording." : "Your prediction differed from the recording.");
  }
  function record(move, pred, actual) {
    tally = tally.filter(function (t) { return !(t.c === st.c.id && t.move === move); });
    if (pred != null) tally.push({ c: st.c.id, move: move, ok: pred === actual });
  }
  function promptBox(parent, label, text, note) {
    var d = add(parent, h("details", "more")); add(d, h("summary", null, label));
    if (note) add(d, h("p", "fine", note));
    add(d, h("pre", "text-box mono", text));
  }

  // ---------------------------------------------------------------- Move 1: predict and reveal
  // ---------------------------------------------------------------- the six-stage strip
  var EX = window.BTA_EXCERPTS || null;
  function plain(t) { return t.replace(/\*\*?/g, ""); }                      // display only: drop Markdown emphasis marks
  function firstWords(t) { var x = plain(t).replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim(), m = /^.{20,160}?[.!?](\s|$)/.exec(x); return m ? m[0].trim() : opening(x, 140); }
  var ROLE = ["advisor", "critic", "summarizer", "advisor", "critic", "summarizer"];
  function drawStrip(c) {
    var ol = clear($("m1-strip")), sel = EX && EX.case === c.id;
    $("stage-full").hidden = true;
    // Researcher-reviewed excerpts exist only for the featured case; every other case is a plain timeline of the six
    // steps, each opening to its exact recorded text (no summaries, no selected passages).
    ol.className = sel ? "strip" : "timeline";
    $("strip-wrap").setAttribute("data-mode", sel ? "strip" : "timeline");
    $("m1-strip-cap").textContent = sel
      ? "One exact passage from each handoff (formatting marks removed). Select a handoff for its full text and who chose the passage."
      : "";
    $("m1-strip-cap").hidden = !sel;
    $("tl-more").hidden = true; clear($("tl-list"));
    if (!sel) { drawTimeline(c, ol); return; }
    text(c.id, function (t) {
      if (t.id !== st.c.id) return; clear(ol);
      t.chain.forEach(function (tx, i) {
        var li = add(ol, h("li")), ex = sel ? EX.strip[i] : null;
        var b = add(li, btn("stage", null, function () { openStage(t, i, ex, b); }));
        b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", "stage-full");
        var hd = add(b, h("span", "st-h")); add(hd, h("span", "st-n", String(i + 1))); add(hd, h("span", "st-r", ROLE[i]));
        add(b, h("q", "st-x", ex ? (ex.lead ? "… " : "") + plain(ex.text) : firstWords(tx)));
        if (i === 0) add(b, h("span", "st-in", "explicitly given the priority"));
      });
      var fl = add(ol, h("li", "st-final")); add(fl, h("span", "st-n", "?")); add(fl, h("span", "st-r", "final decision"));
      ol.scrollLeft = 0; stripPos();
    });
  }
  function drawTimeline(c, ol) {
    ROLE.forEach(function (r, i) {
      var li = add(ol, h("li", "tl-chip")); add(li, h("span", "st-n", String(i + 1))); add(li, h("span", "tl-r", r));
      if (i === 0) add(li, h("span", "st-in", "given the priority"));
    });
    var fl = add(ol, h("li", "tl-chip tl-final")); add(fl, h("span", "st-n", "?")); add(fl, h("span", "tl-r", "final decision"));
    var more = $("tl-more"), list = clear($("tl-list")); more.hidden = false; more.open = false;
    ROLE.forEach(function (r, i) {
      var d = add(list, h("details", "tl-d")), sm = add(d, h("summary"));
      add(sm, h("span", "st-n", String(i + 1))); add(sm, h("span", "tl-r", r));
      if (i === 0) add(sm, h("span", "st-in", "explicitly given the priority"));
      add(sm, h("span", "tl-open", "exact text"));
      var box = add(d, h("div", "text-box tl-text", "Loading the recorded text…"));
      text(c.id, function (t) { if (t.id === c.id) box.textContent = t.chain[i]; });
    });
  }
  // Phone: the strip scrolls sideways; these buttons step through it one handoff at a time and say where you are.
  function stages() { return $("m1-strip").querySelectorAll("li"); }
  function stripFirst() {
    var ol = $("m1-strip"), li = stages(), x = ol.scrollLeft + 4;
    for (var i = 0; i < li.length; i++) if (li[i].offsetLeft - ol.offsetLeft + li[i].offsetWidth > x + li[i].offsetWidth / 2) return i;
    return li.length - 1;
  }
  function stripPos() {
    var ol = $("m1-strip"), li = stages(), n = li.length - 1; if (!n || ol.className !== "strip") return;
    var i = stripFirst(), last = ol.scrollLeft + ol.clientWidth >= ol.scrollWidth - 4;
    var j = i; while (j + 1 <= n && li[j + 1].offsetLeft - ol.offsetLeft + li[j + 1].offsetWidth <= ol.scrollLeft + ol.clientWidth + 4) j++;
    $("strip-pos").textContent = i >= n ? "The final decision" : "Handoff " + (i + 1) + (Math.min(j, n - 1) > i ? "–" + (Math.min(j, n - 1) + 1) : "") + " of 6" + (j >= n ? " · then the final decision" : "");
    $("strip-prev").disabled = ol.scrollLeft <= 2; $("strip-next").disabled = last;
  }
  function stripGo(d) {
    var ol = $("m1-strip"), li = stages(), i = Math.max(0, Math.min(li.length - 1, stripFirst() + d));
    ol.scrollLeft = li[i].offsetLeft - ol.offsetLeft;
  }
  $("strip-prev").addEventListener("click", function () { stripGo(-1); });
  $("strip-next").addEventListener("click", function () { stripGo(1); });
  $("m1-strip").addEventListener("scroll", function () { stripPos(); }, { passive: true });
  window.addEventListener("resize", function () { if (cur === "s-m1") stripPos(); });
  function openStage(t, i, ex, b) {
    var p = $("stage-full"), same = !p.hidden && p.getAttribute("data-i") === String(i);
    Array.prototype.forEach.call($("m1-strip").querySelectorAll(".stage"), function (x) { x.setAttribute("aria-expanded", "false"); });
    if (same) { p.hidden = true; return; }
    stageOpener = b;                                           // v4 W8: focus returns here when the panel closes
    p.hidden = false; p.setAttribute("data-i", String(i)); b.setAttribute("aria-expanded", "true");
    $("sf-title").textContent = "Handoff " + (i + 1) + " · " + ROLE[i] + " · full recorded text";
    $("sf-where").textContent = ex ? "The selected passage is in: " + ex.section + ". " +
      ((EX.pending || []).indexOf(i + 1) >= 0 ? "This passage was chosen by the site's developers and has not yet been reviewed by the researchers." :
       "This passage was selected by the researchers.") : "";
    $("sf-text").textContent = t.chain[i];
  }
  var stageOpener = null;
  function closeStage() {
    $("stage-full").hidden = true;
    Array.prototype.forEach.call($("m1-strip").querySelectorAll(".stage"), function (x) { x.setAttribute("aria-expanded", "false"); });
    if (stageOpener && document.contains(stageOpener)) stageOpener.focus();
  }
  $("sf-close").addEventListener("click", closeStage);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("stage-full").hidden) { e.preventDefault(); closeStage(); } });
  function drawStory() {
    if (!EX) return;
    var L = EX.cards.later;
    $("cc-asked").textContent = EX.cards.asked.summary;
    $("cc-later").textContent = L.summary;
    var fc = BY[EX.case], m = /Option ([AB])/.exec(L.still.text);
    $("cc-still").textContent = "Handoff 6 also still says: “" + L.still.text + "”" + (fc && m ? " (Option " + m[1] + ": " + fc.options[m[1]] + ")" : "");
  }

  // ---------------------------------------------------------------- entry: choose what matters
  // Plain labels for the four value conflicts in the recorded scenarios, and for each value as a priority.
  var TOPICS = [["achievement_benevolence", "Personal achievement or helping others?"],
                ["security_stimulation", "Predictability or trying something new?"],
                ["self_direction_tradition", "Independence or established practices?"],
                ["power_universalism", "Personal influence or wider benefit?"]];
  var VALUE = { "Achievement": "My own achievement", "Benevolence": "Helping others directly", "Security": "Predictability",
                "Stimulation": "New experiences and variety", "Self-Direction": "Making my own decisions", "Tradition": "Established practices",
                "Power": "Personal influence over decisions", "Universalism": "Spreading benefits broadly" };
  function scenariosOf(pair) {
    var out = []; S.cases.forEach(function (c) { if (c.pair === pair && c.order === "orig" && c.priority_index === "p0") out.push(c); });
    return out;
  }
  function drawTopics() {
    var box = clear($("topics"));
    TOPICS.forEach(function (tp) {
      var sc = scenariosOf(tp[0]);
      var b = add(box, btn("topic", null, function () { drawChoose(tp, 0); show("s-choose"); }));
      b.setAttribute("data-pair", tp[0]);
      add(b, h("b", null, tp[1]));
      add(b, h("span", null, sc.map(function (c) { return c.title; }).join(" · ")));
    });
  }
  function situation(task) { return task.replace(/\s*Select exactly one option for the user\.\s*$/, ""); }
  function drawChoose(tp, k) {
    var sc = scenariosOf(tp[0]), c = sc[k];
    $("h-choose").textContent = tp[1];
    var tabs = clear($("sit-tabs")); tabs.hidden = sc.length < 2;
    sc.forEach(function (x, i) {
      var b = add(tabs, btn("sit-tab", x.title, function () { drawChoose(tp, i); }));
      b.setAttribute("aria-pressed", i === k ? "true" : "false");
    });
    $("sit-title").textContent = c.title;
    $("sit-task").textContent = situation(c.task);
    var ul = clear($("sit-opts"));
    ["A", "B"].forEach(function (o) { var li = add(ul, h("li")); add(li, h("b", null, "Option " + o + " ")); add(li, document.createTextNode(c.options[o])); });
    var pk = clear($("picks"));
    ["p0", "p1"].forEach(function (p) {
      var x = BY[c.scenario + "_orig_" + p];
      var b = add(pk, btn("pick", null, function () { load(x, ["s-intro", "s-choose"]); show("s-m1"); }));
      b.setAttribute("data-case", x.id);
      add(b, h("b", null, VALUE[x.focal_value] + " matters more"));
      add(b, h("q", null, x.priority));
    });
  }

  function drawM1() {
    var c = st.c;
    $("m1-pri").textContent = c.priority;
    $("m1-task").textContent = "Decision: " + c.title + ". " + c.task;
    $("m1-label").textContent = c.id === S.selection.opening_case ? S.selection.opening_label : "";
    drawStrip(c);
    guessButtons($("m1-guess"), [["A", "Option A", c.options.A, c.target === "A" ? "Fits the priority" : ""], ["B", "Option B", c.options.B, c.target === "B" ? "Fits the priority" : ""], ["ABSTAIN", "No choice", "It answered UNCLEAR"]],
                 function (p) { st.p1 = p; drawM1r(); show("s-m1r"); });
  }
  $("m1-skip").addEventListener("click", function () { st.p1 = null; drawM1r(); show("s-m1r"); });
  function drawM1r() {
    var c = st.c, a = c.choices.delegated, o = c.outcomes.delegated;
    guessButtons($("m2-guess"), [["A", "Option A", c.options.A, c.target === "A" ? "Fits the priority" : ""], ["B", "Option B", c.options.B, c.target === "B" ? "Fits the priority" : ""], ["ABSTAIN", "No choice", "It answers UNCLEAR"]],
                 function (p) { st.p2 = p; drawM2(); drawM2r("restored"); show("s-m2r"); });
    record(1, st.p1, a);
    $("h-m1r").textContent = o === "matched" ? "The AI chose the option that fits the person's priority." :
                             o === "opposite" ? "The AI chose the other option, not the one that fits the person's priority." :
                             "The AI didn't make a choice: it answered UNCLEAR.";
    tile($("m1r-tile"), c, "delegated");
    $("m1r-you").textContent = youLine(st.p1, a);
    var m = clear($("m1r-more"));
    text(c.id, function (t) {
      if (t.id !== st.c.id) return; clear(m);
      add(m, h("div", "text-box", t.decisions.delegated.text));
      promptBox(m, "Exact final-decision prompt", t.decisions.delegated.prompt, HANDOFF + " stands for handoff 6, inserted verbatim.");
    });
  }

  // ---------------------------------------------------------------- Move 2: try an intervention
  function drawM2() {
    var o = st.c.outcomes.delegated;
    $("m2-intro").textContent = o === "opposite" ? "Without a reminder it chose the other option. Which test would you run first?" :
      o === "matched" ? "It already chose the fitting option. Does that hold when the priority comes back? Pick a test." :
      "It didn't make a choice. Would bringing the priority back lead to one? Pick a test.";
    Array.prototype.forEach.call($("m2-choices").querySelectorAll(".iv"), function (b) {
      b.setAttribute("data-seen", st.seen.indexOf(b.getAttribute("data-iv")) >= 0 ? "yes" : "no");
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("#m2-choices .iv"), function (b) {
    b.addEventListener("click", function () { drawM2r(b.getAttribute("data-iv")); show("s-m2r"); });
  });
  function drawM2r(iv) {
    var c = st.c, d = c.choices.delegated, x = c.choices[iv];
    if (st.seen.indexOf(iv) < 0) st.seen.push(iv);
    var sb = document.querySelector('#m2-choices [data-iv="' + iv + '"]'); if (sb) sb.setAttribute("data-seen", "yes");
    $("m2r-eye").textContent = iv === "restored" ? "Step 2 · Reminder at the final decision · recorded result" : "Optional · Re-added at handoff 4 · recorded result";
    $("h-m2r").textContent = "With " + IV[iv].name + ", " + (d === x ? "the choice stayed the same." : "the choice changed.");
    tile($("m2r-a"), c, "delegated");
    if (iv === "restored" && st.p2 !== undefined) { record(2, st.p2, x); $("m2r-you").textContent = youLine(st.p2, x); } else $("m2r-you").textContent = "";
    var b = $("m2r-b"); b.querySelector(".k").textContent = IV[iv].key; tile(b, c, iv);
    b.setAttribute("data-changed", d === x ? "no" : "yes");
    var how = $("m2r-how");
    how.className = iv === "restored" ? "how-diff" : "how-diff warn";
    how.textContent = iv === "restored"
      ? "Same handoff 6 as in step 1, plus one line repeating the person's own words (labelled USER PRIORITY). The handoffs weren't rewritten or repaired."
      : "Not a final-prompt comparison: handoffs 4–6 were written anew, so any difference mixes the re-added priority with ordinary run-to-run variation.";
    var m = clear($("m2r-more")); $("m2r-details").open = false;
    text(c.id, function (t) {
      if (t.id !== st.c.id) return; clear(m);
      if (iv === "reanchored") t.reanchor.forEach(function (tx, j) {
        var dd = add(m, h("details", "more")); add(dd, h("summary", null, "New handoff " + (j + 4) + (j === 0 ? " (with the priority re-added)" : "")));
        add(dd, h("div", "text-box", tx));
        add(dd, h("p", "fine", PREV + " stands for " + (j === 0 ? "the saved handoff 3" : "new handoff " + (j + 3)) + ", inserted verbatim."));
        add(dd, h("pre", "text-box mono", t.reanchor_prompts[j]));
      });
      add(m, h("span", "k", "Recorded final answer")); add(m, h("div", "text-box", t.decisions[iv].text));
      promptBox(m, "Exact final-decision prompt", t.decisions[iv].prompt, HANDOFF + " stands for " + (iv === "restored" ? "the same saved handoff 6" : "the new handoff 6") + ", inserted verbatim." + (iv === "restored" ? " The only difference from step 1's prompt is the USER PRIORITY line." : ""));
    });
    var o = clear($("m2r-other")), other = iv === "restored" ? "reanchored" : "restored";
    if (st.seen.indexOf(other) < 0) {
      add(o, btn("btn ghost sm", "Now inspect the other test: " + IV[other].short.toLowerCase(), function () { drawM2r(other); show("s-m2r"); }));
    } else {
      var g = add(o, h("div", "both"));
      add(g, h("span", "k", "Both tests for this case"));
      ["delegated", "restored", "reanchored"].forEach(function (k) {
        var r = add(g, h("p", "both-r"));
        add(r, h("span", "oc-dot bg-" + c.outcomes[k]));
        add(r, h("b", null, (k === "delegated" ? "No reminder" : IV[k].short) + ": "));
        add(r, document.createTextNode(CH[c.choices[k]] + " · " + OC[c.outcomes[k]]));
      });
    }
    $("m2-counter").open = false;
  }
  $("m2-counter").addEventListener("toggle", function () {
    if (!$("m2-counter").open) return;
    var x = BY[S.selection.counterexample], o = clear($("m2-counter-in"));
    add(o, h("p", "fine", "Rule: " + S.selection.counterexample_rule + ". It shows that re-adding the priority midway can also be followed by a choice away from the priority; it is not typical of the 28 cases." + (x.id === st.c.id ? " It is the case you're looking at." : "")));
    add(o, h("p", null, x.title + " · options " + (x.order === "orig" ? "as built" : "swapped") + " · “" + x.priority + "”"));
    ["delegated", "reanchored", "restored"].forEach(function (k) {
      var r = add(o, h("p", "both-r"));
      add(r, h("span", "oc-dot bg-" + x.outcomes[k]));
      add(r, h("b", null, (k === "delegated" ? "No reminder" : IV[k].short) + ": "));
      add(r, document.createTextNode(CH[x.choices[k]] + " (" + x.options[x.choices[k]] + ") · " + OC[x.outcomes[k]]));
    });
    var a = add(o, h("a", null, "Step through this counterexample →")); a.href = "experiment.html#case/" + x.id + "/reanchored";
  });

  // ---------------------------------------------------------------- Move 3: flip the priority
  function drawM3() {
    var c = st.c, f = flipOf(c), d = c.choices.delegated, o = d === "A" ? "B" : "A";
    function fit(k) { return k === f.target ? "Fits the new priority" : ""; }
    $("m3-p1").textContent = "“" + c.priority + "”";
    $("m3-p2").textContent = "“" + f.priority + "”";
    var items = d === "ABSTAIN"
      ? [["A", "It will choose Option A", f.options.A, fit("A")], ["B", "It will choose Option B", f.options.B, fit("B")], ["ABSTAIN", "Still no choice", "UNCLEAR again"]]
      : [[o, "It will switch to Option " + o, c.options[o], fit(o)],
         [d, "It will stay with Option " + d, c.options[d], fit(d)],
         ["ABSTAIN", "No choice", "It answers UNCLEAR"]];
    $("m3-ask").textContent = "With no reminder, the first priority got " + (d === "ABSTAIN" ? "no choice (UNCLEAR)" : "Option " + d) + ". What will this one get?";
    guessButtons($("m3-guess"), items, function (p) { st.p3 = p; drawM3r(); show("s-m3r"); });
  }
  $("m3-skip").addEventListener("click", function () { st.p3 = null; drawM3r(); show("s-m3r"); });
  function drawM3r() {
    var c = st.c, f = flipOf(c), a = c.choices.delegated, b = f.choices.delegated;
    st.flipSeen = true;
    record(3, st.p3, b);
    $("h-m3r").textContent =
      a === b ? (a === "ABSTAIN" ? "It didn't make a choice either time." : "The final choice didn't change: Option " + a + " both times.") :
      b === "ABSTAIN" ? "This time it didn't make a choice (UNCLEAR). That isn't the same as switching." :
      a === "ABSTAIN" ? "This time it chose Option " + b + "." : "The final choice switched to Option " + b + ".";
    $("m3r-you").textContent = youLine(st.p3, b);
    var lg = clear($("m3r-legend"));
    ["A", "B"].forEach(function (k) { var p = add(lg, h("p")); add(p, h("b", null, "Option " + k + " ")); add(p, document.createTextNode(c.options[k])); if (k === c.target) add(p, h("span", "tag1", "fits the first priority")); if (k === f.target) add(p, h("span", "tag2", "fits the opposite priority")); });
    var tb = $("m3r-table"), cap = tb.querySelector("caption");
    clear(tb); tb.appendChild(cap);
    var hr = add(add(tb, h("thead")), h("tr"));
    ["Condition", "First priority", "Opposite priority", "Followed both?"].forEach(function (t) { add(hr, h("th", null, t)).setAttribute("scope", "col"); });
    var body = add(tb, h("tbody"));
    [["delegated", "Handoffs only, no reminder"], ["restored", "Priority repeated at the final decision"], ["direct", "Told directly, no handoffs"]].forEach(function (r) {
      var tr = add(body, h("tr")); tr.setAttribute("data-cond", r[0]);
      add(tr, h("th", null, r[1])).setAttribute("scope", "row");
      [[c, OC1], [f, OCF]].forEach(function (y) {
        var x = y[0], td = add(tr, h("td")); td.setAttribute("data-label", y[0] === c ? "First priority" : "Opposite priority"); add(td, h("span", "oc-dot bg-" + x.outcomes[r[0]]));
        add(td, h("b", null, CH[x.choices[r[0]]])); add(td, h("small", null, y[1][x.outcomes[r[0]]]));
      });
      var both = c.outcomes[r[0]] === "matched" && f.outcomes[r[0]] === "matched";
      add(tr, h("td", both ? "yes" : "no", both ? "Yes" : "No")).setAttribute("data-label", "Followed both?");
    });
    var p = clear($("m3r-pilot"));
    add(p, h("span", "k", "Across our earlier pilot (Study 3B; the home page's numbers are the larger Study 4) · " + S.paired_sensitive_orders.delegated.n + " decision-and-order pairs"));
    add(p, h("p", null, "Both opposite priorities got their corresponding option in:"));
    [["delegated", "Handoffs only, no reminder"], ["restored", "Priority repeated at the final decision"], ["direct", "Told directly, no handoffs"]].forEach(function (r) {
      var s = S.paired_sensitive_orders[r[0]], row = add(p, h("div", "pbar")); row.setAttribute("data-cond", r[0]);
      add(row, h("span", "pbar-l", r[1]));
      var tr = add(row, h("span", "pbar-t")), fill = add(tr, h("i")); fill.style.width = (100 * s.k / s.n) + "%";
      add(row, h("b", null, s.k + " of " + s.n));
    });
    add(p, h("p", "fine", "UNCLEAR counts neither as following nor as the opposite. An additional check, not proof of general alignment."));
    var m = clear($("m3r-more"));
    text(f.id, function (t) {
      if (t.id !== flipOf(st.c).id) return; clear(m);
      add(m, h("span", "k", "Handoff 6 in the opposite-priority run")); add(m, h("div", "text-box", t.chain[5]));
      add(m, h("span", "k", "Its recorded final answer, without a reminder")); add(m, h("div", "text-box", t.decisions.delegated.text));
      var a2 = add(m, h("a", null, "Step through the opposite-priority run →")); a2.href = "experiment.html#replay/" + f.id;
    });
  }

  // ---------------------------------------------------------------- takeaway, more cases, method card
  function recapRows(c) {
    var f = flipOf(c);
    return [["No reminder", c, "delegated"], [IV.restored.short, c, "restored"], [IV.reanchored.short + " (new handoffs 4–6)", c, "reanchored"], ["Opposite priority, no reminder", f, "delegated"]];
  }

  function recapText(c, x) {
    var ch = x[1].choices[x[2]];
    if (x[1] === c) return CH[ch] + " · " + OC[x[1].outcomes[x[2]]];
    var a = c.choices.delegated;
    return CH[ch] + " · " + OCF[x[1].outcomes[x[2]]] + (ch === "ABSTAIN" || a === "ABSTAIN" ? "" : ch === a ? " (the same option as before)" : " (a different option)");
  }
  function drawEnd() {
    var c = st.c, r = clear($("end-recap")), N = S.n_cases;
    function line(k) { var x = S.counts[k]; return x.matched + " of " + N + " fitted · " + x.opposite + " the other option · " + x.unclear + " no choice (UNCLEAR)"; }
    $("cp-n0").textContent = line("direct"); $("cp-n1").textContent = line("delegated"); $("cp-n2").textContent = line("restored");
    var ps = S.paired_sensitive_orders;
    $("cp-pairs").textContent = "Both opposite priorities got their own option in " + ps.direct.k + " of " + ps.direct.n + " decision-and-order pairs when told directly, " +
      ps.delegated.k + " of " + ps.delegated.n + " with the handoff only, and " + ps.restored.k + " of " + ps.restored.n + " with the reminder.";
    $("cp-cap").textContent = "Recorded earlier pilot (Study 3B; the main study, Study 4, is on the home page), one model (Gemini 2.5 Pro): " + S.n_scenarios + " constructed decisions × 2 opposing priorities × 2 option orders = " + N +
      " cases, one run each. UNCLEAR is a separate outcome, not the other option. Not a universal fix, not evidence of a better decision, and not evidence of what happened inside the model.";
    var np = S.no_priority.choices;
    $("cp-base").textContent = "Separately, the same model was asked each decision once with no priority at all (a single direct question, not a six-handoff workflow): Option A " +
      (np.A || 0) + " · Option B " + (np.B || 0) + " · no choice (UNCLEAR) " + (np.ABSTAIN || 0) + " of " + S.no_priority.n + " decision-and-order pairs.";
    $("cp-alt").textContent = "Other explanations remain open, for example how the final step interpreted handoff 6, a preference for one option's content, and changes in the advice across the handoffs. One run per case can't tell these apart.";
    add(r, h("span", "k", "This case, as recorded · " + c.title));
    add(r, h("p", "fine", "Priority: “" + c.priority + "”"));
    var seen = { delegated: true, restored: st.seen.indexOf("restored") >= 0, reanchored: st.seen.indexOf("reanchored") >= 0, flip: !!st.flipSeen };
    recapRows(c).forEach(function (x, i) {
      var key = i === 3 ? "flip" : x[2], p = add(r, h("p", "both-r")); p.setAttribute("data-explored", seen[key] ? "yes" : "no");
      add(p, h("span", "oc-dot bg-" + x[1].outcomes[x[2]]));
      add(p, h("b", null, x[0] + ": ")); add(p, document.createTextNode(recapText(c, x)));
      add(p, h("span", "explored", seen[key] ? " · you explored this" : " · not explored; recorded result"));
    });
    var n = tally.length, k = tally.filter(function (t) { return t.ok; }).length;
    $("end-score").textContent = n ? "Your predictions matched the recording " + k + " of " + n + " times in this tab. That's only a count on these selected cases, not a measure of auditing skill, and it isn't saved or sent anywhere." : "";
    var mc = clear($("end-cases"));
    [["opposite", S.selection.opening_case, "The opening example"]].concat(EXTRA).forEach(function (e) {
      var x = BY[e[1]]; if (x.id === c.id) return;
      var b = add(mc, btn("card mcase", null, function () { load(x); show("s-m1"); }));
      add(b, h("span", "oc-dot bg-" + x.outcomes.delegated)); add(b, h("span", "k", "No reminder: " + e[2].toLowerCase()));
      add(b, h("b", null, x.title)); add(b, h("span", null, "“" + opening(x.priority, 90) + "”"));
    });
    $("end-rule").textContent = EXTRA_RULE;
    var dist = clear($("end-dist-in")), cn = S.counts.delegated;
    add(dist, h("p", null, "With no reminder, across all " + S.n_cases + " recorded cases of the earlier pilot (Study 3B):"));
    [["matched", "Chose the option that fits"], ["opposite", "Chose the other option"], ["unclear", "Didn't make a choice (UNCLEAR)"]].forEach(function (o) {
      var row = add(dist, h("div", "pbar")); row.setAttribute("data-oc", o[0]);
      add(row, h("span", "pbar-l", o[1])); var tr = add(row, h("span", "pbar-t")), fi = add(tr, h("i", "bg-" + o[0])); fi.style.width = (100 * cn[o[0]] / S.n_cases) + "%";
      add(row, h("b", null, cn[o[0]] + " of " + S.n_cases));
    });
    add(dist, h("p", "fine", "The cases offered here were picked by a fixed rule to show each kind of outcome once. That mix isn't the dataset's. With the priority repeated at the final decision: " + S.counts.restored.matched + " of " + S.n_cases + " chose the fitting option."));
    var a = add(dist, h("a", null, "See all 28 cases on the results page →")); a.href = "results.html";
    $("card-msg").textContent = "";
  }
  $("end-again").addEventListener("click", function () { load(st.c); show("s-m1"); });
  $("end-choose").addEventListener("click", function () { st.hist = []; show("s-intro"); });

  var REC = "Keep the person's stated priorities available when making the final decision. If AI thinks another consideration should guide the choice, make that explicit so the person can evaluate it.";
  function card() {
    var c = st.c, doc = document.implementation.createHTMLDocument("Priority Checkpoint: method card");
    var meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.insertBefore(meta, doc.head.firstChild);
    var vp = doc.createElement("meta"); vp.setAttribute("name", "viewport"); vp.setAttribute("content", "width=device-width, initial-scale=1"); doc.head.appendChild(vp);
    function e(p, tag, cls, t) { var n = doc.createElement(tag); if (cls) n.className = cls; if (t != null) n.textContent = t; p.appendChild(n); return n; }
    var sheet = e(doc.body, "main", "sheet");
    var hd = e(sheet, "header", "hd");
    e(hd, "p", "eye", "Method card · Anchor-Preservation Auditor · Cosmos Institute");
    e(hd, "h1", null, "Priority Checkpoint");
    e(hd, "p", "rec", REC);
    e(hd, "p", "sub", "A design recommendation from a small recorded pilot, not a validated universal rule. Three checks for any workflow where an AI passes work through several steps and then decides for a person; all you need is your workflow's final step and a few runs.");
    var ol = e(sheet, "ol", "checks");
    [["Check which option the AI actually chose, not just what its explanation mentions.",
      "Have the final step begin with one fixed line, such as FIRST CHOICE: A, FIRST CHOICE: B or FIRST CHOICE: UNCLEAR, and read that line before the explanation.",
      "The option that was actually picked, by its content.",
      "UNCLEAR, a non-choice, is not the same as picking the other option."],
     ["Compare the final decision with and without explicitly repeating the user's priority.",
      "Run the final step twice on the same input. In the second run, add one line: USER PRIORITY: followed by the user's own words.",
      "Whether the chosen option changes.",
      "A single change is an observed difference, not proof of a reliable effect: repeat it. The reminder doesn't repair earlier steps and doesn't show which choice is better."],
     ["Reverse the priority and see whether the decision responds appropriately.",
      "Write the opposite priority and run it through the workflow from the start, with the options in the same order.",
      "Each priority getting its own corresponding option. Compare the option's content, not just its letter.",
      "An additional check, not proof of general alignment. New runs also bring ordinary run-to-run variation."]].forEach(function (x, i) {
      var li = e(ol, "li", null); e(li, "span", "n", String(i + 1)); e(li, "h2", null, x[0]);
      var dl = e(li, "dl"); e(dl, "dt", null, "How"); e(dl, "dd", null, x[1]); e(dl, "dt", null, "Look for"); e(dl, "dd", null, x[2]); e(dl, "dt", null, "Careful"); e(dl, "dd", null, x[3]);
    });
    var low = e(sheet, "section", "low");
    var tp = e(low, "div", "box");
    e(tp, "h3", null, "The final-step prompt we used");
    e(tp, "p", "small", "The second run adds the USER PRIORITY line; everything else is identical.");
    e(tp, "pre", null, CORE.prompt({ task: "<the decision>", a: "<option A>", b: "<option B>", priority: "<the user's priority, in their words>", handoff: "<what your final step received>" }, true).trim());
    var ex = e(low, "div", "box");
    e(ex, "h3", null, "Recorded example from our pilot · " + c.title);
    e(ex, "p", "small", "Priority: “" + c.priority + "”");
    var ul = e(ex, "ul", null);
    recapRows(c).forEach(function (x) { e(ul, "li", null, x[0] + ": " + recapText(c, x)); });
    var ps = S.paired_sensitive_orders;
    e(ex, "p", "small", "Across all " + S.n_cases + " recorded cases, the final choice fitted the priority in " + S.counts.delegated.matched + " without a reminder and " + S.counts.restored.matched + " with it. Both opposite priorities got their own option in " + ps.delegated.k + " of " + ps.delegated.n + " pairs without a reminder, " + ps.restored.k + " of " + ps.restored.n + " with it, and " + ps.direct.k + " of " + ps.direct.n + " when told directly.");
    e(ex, "p", "small", "A small development pilot: one model (Gemini 2.5 Pro), " + S.n_scenarios + " constructed decisions, one run per case. Only handoff 1 explicitly received the priority; the final step received handoff 6, not the priority as a separate instruction. It describes these cases, not how often this happens elsewhere or what happened inside the model.");
    var ft = e(sheet, "footer", "ft");
    var base = (window.SITE_CONFIG || {}).publicBase;
    [["Make a Priority Checkpoint brief for your own AI chats: ", "checkpoint.html", "the Priority Checkpoint page"],
     ["Try it on your own system: ", "test.html", "the “For developers” page"],
     ["Full research, methods and data: ", "research.html", "the Research page"]].forEach(function (x) {
      var p = e(ft, "p", null, x[0]);
      if (base) { var a = e(p, "a", null, new URL(x[1], base).href); a.href = a.textContent; }
      else e(p, "span", null, x[2] + " of the Anchor-Preservation Auditor website");
    });
    e(ft, "p", "small", "Matching a stated priority doesn't make a choice the better decision. These checks show whether a choice followed what the user said, in the runs you made.");
    var css = "@page{size:A4;margin:10mm}*{box-sizing:border-box}html{background:#e9edf5}body{margin:0;font:9.7pt/1.36 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141a2b}" +
      ".sheet{max-width:190mm;margin:16px auto;background:#fff;padding:10mm 11mm 8mm;border-radius:6px;box-shadow:0 6px 30px rgba(20,26,43,.18)}" +
      ".rec{margin:0 0 5px;font-size:10.6pt;font-weight:600;color:#141a2b}.hd{border-bottom:3px solid;border-image:linear-gradient(90deg,#0891b2,#7c3aed) 1;padding-bottom:8px;margin-bottom:10px}.eye{margin:0 0 4px;font-size:7.6pt;letter-spacing:.12em;text-transform:uppercase;color:#0e7490;font-weight:700}" +
      "h1{font-size:17pt;line-height:1.15;margin:0 0 5px;letter-spacing:-.01em}.sub{margin:0;color:#475069}" +
      ".checks{list-style:none;padding:0;margin:0 0 8px;display:grid;gap:6px}.checks li{position:relative;padding:6px 10px 5px 42px;border:1px solid #d8deea;border-radius:8px;background:#f8fafd}" +
      ".n{position:absolute;left:10px;top:9px;width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#0891b2,#7c3aed);color:#fff;font-weight:700;display:grid;place-items:center;font-size:10.5pt}" +
      "h2{font-size:10.8pt;margin:0 0 4px;line-height:1.25}dl{display:grid;grid-template-columns:74px 1fr;gap:1px 8px;margin:0}dt{font-weight:700;color:#0e7490;font-size:8.6pt;text-transform:uppercase;letter-spacing:.05em;padding-top:1px}dd{margin:0}" +
      ".low{display:grid;grid-template-columns:1fr 1fr;gap:8px}.box{border:1px solid #d8deea;border-radius:8px;padding:8px 10px}h3{font-size:9.6pt;margin:0 0 4px}.small{font-size:8.2pt;color:#475069;margin:3px 0}" +
      "pre{white-space:pre-wrap;word-break:break-word;font:6.9pt/1.3 ui-monospace,Menlo,Consolas,monospace;background:#f1f4fa;border-radius:6px;padding:6px 7px;margin:4px 0 0}ul{margin:3px 0;padding-left:15px;font-size:8.6pt}" +
      ".ft{margin-top:9px;border-top:1px solid #d8deea;padding-top:6px;font-size:8.8pt}.ft p{margin:2px 0}a{color:#0e7490}" +
      "@media print{html{background:#fff}.sheet{margin:0;box-shadow:none;border-radius:0;padding:0;max-width:none}}@media(max-width:640px){.low{grid-template-columns:1fr}.sheet{margin:0;border-radius:0}}";
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace("</head>", "<style>" + css + "</style></head>");
  }
  $("card-dl").addEventListener("click", function () {
    var url = URL.createObjectURL(new Blob([card()], { type: "text/html" })), a = document.createElement("a");
    a.href = url; a.download = "auditor-method-card.html"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    $("card-msg").textContent = "Saved auditor-method-card.html: one page, opens in any browser, prints on A4 or Letter.";
  });
  window.__bta = { card: card };   // used by the acceptance test to check the card without a download

  // ---------------------------------------------------------------- start
  function load(c, hist) {
    st.c = c; st.seen = []; st.p1 = st.p2 = st.p3 = undefined; st.flipSeen = false; st.hist = hist || ["s-intro"]; resetJudge();
    drawM1(); text(flipOf(c).id, function () {});
    var hsh = "#" + c.id; if (location.hash !== hsh && history.replaceState) history.replaceState(null, "", hsh);
  }
  Array.prototype.forEach.call(document.querySelectorAll("#judge .jbtn"), function (b) {
    b.addEventListener("click", function () {
      var on = b.getAttribute("aria-pressed") !== "true";
      resetJudge(); b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  });
  function resetJudge() { Array.prototype.forEach.call(document.querySelectorAll("#judge .jbtn"), function (x) { x.setAttribute("aria-pressed", "false"); }); }
  drawTopics(); drawStory();
  $("go-story").addEventListener("click", function () { show("s-story"); });
  $("go-start").addEventListener("click", function () { load(BY[S.selection.opening_case], ["s-intro", "s-story"]); show("s-m1"); });
  function fromHash() {
    var id = location.hash.slice(1);
    // "#start" (the home page's main button): straight to the featured case's first prediction; Back returns to the intro
    if (id === "start") { load(BY[S.selection.opening_case], ["s-intro", "s-story"]); show("s-m1"); return true; }
    if (BY[id]) { load(BY[id]); show("s-m1"); return true; }
    return false;
  }
  window.addEventListener("hashchange", function () { if (location.hash.slice(1) !== st.c.id) fromHash(); });
  if (!fromHash()) { drawM1(); show("s-intro", "init"); }
})();
