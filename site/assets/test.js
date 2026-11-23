// Test a decision: builds the study's two final-decision prompts (core.js = compare.js prompt/parse/outcome),
// reads the first line of each pasted answer with the study's strict parser, and shows one compact result with
// fixed, conservative wording, plus optional follow-up tests (repeat, reverse, swap order). No network, no storage
// of visitor text, no model, no automatic interpretation. Visitor and model text is rendered with textContent only.
(function () {
  "use strict";
  var S = window.STUDY3B, C = window.__v3core;
  if (!S || !C) return;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return arguments[arguments.length - 1]; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function radio(n) { var x = document.querySelector('input[name="' + n + '"]:checked'); return x ? x.value : ""; }
  function setRadio(n, v) { Array.prototype.forEach.call(document.querySelectorAll('input[name="' + n + '"]'), function (x) { x.checked = x.value === v; }); }
  function short(t, n) { t = t.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
  var OPEN = S.cases.filter(function (c) { return c.id === S.selection.opening_case; })[0];

  // ---------------------------------------------------------------- state and fixed wording
  var FICTIONAL = {   // written for this page; not AI output (the same example as the earlier comparison tool)
    task: "A team lead must choose the venue for a two-day team offsite.",
    a: "A quiet countryside retreat with structured work sessions.",
    b: "A city hotel close to museums, restaurants and nightlife.",
    priority: "For this offsite, uninterrupted focus time matters more to me than entertainment options.",
    target: "A",
    handoff: "Overall, the city hotel offers the broadest benefits for the team, with a quiet room for focused work.",
    ra: "FIRST CHOICE: B\nThe advice says the city hotel offers the broadest benefits, and a quiet room still allows focused work.",
    rb: "FIRST CHOICE: A\nYou said uninterrupted focus matters more than entertainment. The countryside retreat protects focus time; the city hotel's main advantages are entertainment."
  };
  var st = { m: null, src: "own", mode: "", prev: null, session: [], cur: null };
  var READ = { A: "Option A", B: "Option B", UNCLEAR: "Declined to choose", INVALID: "No valid choice line" };
  var OC = { matched: "✓ The option you linked to the priority", opposite: "⇄ The other option", unclear: "? Declined to choose",
             uncertain: "– Not compared: you weren't sure which option fits", invalid: "! No valid first line" };
  var SRCTXT = {
    own: "Your comparison: answers from your workflow's final step, as you pasted them. This page ran no AI; it read the first line of each answer.",
    chat: "Method demo: answers from a general chat assistant. This shows how the test works; it doesn't test your workflow.",
    fictional: "Made-up example, written for this page to show the method. It says nothing about your workflow.",
    recorded: "Recorded example from our pilot (Gemini 2.5 Pro): the final decision received handoff 6. Replayed, not run live, and not your system."
  };
  var KIND = { "": "First comparison", again: "Repeat", reverse: "Reversed priority", swap: "Swapped order" };

  // ---------------------------------------------------------------- routing
  var VIEWS = { "/": "v-test", "/run": "v-run", "/result": "v-result" };
  function route() {
    var r = (location.hash || "#/").slice(1) || "/";
    if (r === "/example") { loadRecorded(); return; }
    if (r === "/run" && !st.m) r = "/";
    if (r === "/result" && !st.cur) r = "/";
    if (!VIEWS[r]) r = "/";
    Object.keys(VIEWS).forEach(function (k) { $(VIEWS[k]).hidden = k !== r; });
    window.scrollTo(0, 0);
    if (route.started) { var hd = $(VIEWS[r]).querySelector("h1"); if (hd) hd.focus({ preventScroll: true }); }
    route.started = true;
  }
  function go(r) { if (location.hash === "#" + r) route(); else location.hash = r; }
  addEventListener("hashchange", route);

  // ---------------------------------------------------------------- step 1: the decision
  var FIELDS = { task: "t-task", a: "t-a", b: "t-b", priority: "t-p", handoff: "t-in" };
  function readForm() { var m = {}; Object.keys(FIELDS).forEach(function (k) { m[k] = $(FIELDS[k]).value.trim(); }); m.target = radio("t-fit"); return m; }
  function fillForm(m) { Object.keys(FIELDS).forEach(function (k) { $(FIELDS[k]).value = m[k] || ""; }); setRadio("t-fit", m.target || ""); }
  function isFictional(m) { return ["task", "a", "b", "priority", "target", "handoff"].every(function (k) { return m[k] === FICTIONAL[k]; }); }
  function notes() {
    var f = isFictional(readForm()), w = radio("t-where");
    $("t-src").hidden = !f; $("t-src").textContent = f ? "Made-up example, written for this page. Its results won't tell you about your own workflow." : "";
    $("t-where-note").textContent = w === "own" ? "Only answers from your workflow's own final step say something about your workflow." :
      w === "chat" ? "A general chat assistant isn't your final step: the result will be labelled as a method demo." : "";
  }
  $("t-example").addEventListener("click", function () { fillForm(FICTIONAL); setRadio("t-where", "chat"); st.mode = ""; $("t-rev").hidden = true; notes(); });
  Object.keys(FIELDS).forEach(function (k) { $(FIELDS[k]).addEventListener("input", notes); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="t-fit"], input[name="t-where"]'), function (x) { x.addEventListener("change", notes); });
  $("t-go").addEventListener("click", function () {
    var m = readForm(), w = radio("t-where");
    var need = [["task", "what's being decided"], ["a", "Option A"], ["b", "Option B"], ["priority", "the user's priority"]].filter(function (f) { return !m[f[0]]; });
    var err = "", focus = null;
    if (need.length) { err = "Please fill in " + need.map(function (f) { return f[1]; }).join(", ") + "."; focus = $(FIELDS[need[0][0]]); }
    else if (!m.target) { err = "Please choose which option the priority should favor (or “Not sure”)."; focus = document.querySelector('input[name="t-fit"]'); }
    else if (!m.handoff) { err = "Please paste one input your final step received."; focus = $("t-in"); }
    else if (!w) { err = "Please say where you'll run the prompts."; focus = document.querySelector('input[name="t-where"]'); }
    else if (st.mode === "reverse" && st.prev && m.priority === st.prev.priority) { err = "For the reverse test, write the opposite priority."; focus = $("t-p"); }
    $("t-err").textContent = err;
    if (err) { focus.focus(); return; }
    st.m = m; st.src = isFictional(m) ? "fictional" : w;
    prepRun(st.mode === "reverse" ? "Reversed priority: same decision and input, with the opposite priority you wrote and the option you said it favors." : "");
    go("/run");
  });

  // ---------------------------------------------------------------- step 2: run
  function showPrompt(pre, text) {
    clear(pre);
    text.split("\n").forEach(function (line, i, all) {
      pre.appendChild(/^USER PRIORITY: /.test(line) ? h("span", "hl", line) : document.createTextNode(line));
      if (i < all.length - 1) pre.appendChild(document.createTextNode("\n"));
    });
  }
  function prepRun(note) {
    showPrompt($("r-pa"), C.prompt(st.m, false)); showPrompt($("r-pb"), C.prompt(st.m, true));
    $("r-line").textContent = "USER PRIORITY: " + st.m.priority;
    $("r-choice").textContent = "Give your initial choice on the first line in exactly this form: FIRST CHOICE: A, FIRST CHOICE: B, or FIRST CHOICE: UNCLEAR.";
    $("r-ra").value = ""; $("r-rb").value = ""; $("r-err").textContent = ""; $("r-copied").textContent = "";
    $("r-note").hidden = !note; $("r-note").textContent = note || "";
    $("r-where").textContent = st.src === "own" ? "Run each through your workflow's final step, with the same model, settings and code path, starting each run fresh." :
      "Paste each into a new chat in any assistant. This demonstrates the method; it doesn't test your workflow.";
    $("r-demo").hidden = st.src !== "fictional";
  }
  function copy(text, label, el) {
    function manual() { if (el) { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } $("r-copied").textContent = label + " is selected: press Ctrl+C or ⌘C."; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { $("r-copied").textContent = label + " copied."; }, manual); else manual();
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (b) {
    b.addEventListener("click", function () { var w = b.getAttribute("data-copy") === "b"; copy(C.prompt(st.m, w), (w ? "The with-reminder" : "The without-reminder") + " prompt", $(w ? "r-pb" : "r-pa")); });
  });
  $("r-fill").addEventListener("click", function () { $("r-ra").value = FICTIONAL.ra; $("r-rb").value = FICTIONAL.rb; });
  $("r-back").addEventListener("click", function () { fillForm(st.m); notes(); go("/"); });
  $("r-go").addEventListener("click", function () {
    var ra = $("r-ra").value, rb = $("r-rb").value;
    if (!ra.trim() || !rb.trim()) { $("r-err").textContent = "Please paste both answers."; (ra.trim() ? $("r-rb") : $("r-ra")).focus(); return; }
    var p = [C.parse(ra), C.parse(rb)];
    record({ m: JSON.parse(JSON.stringify(st.m)), src: st.src, answers: [ra, rb], parsed: p, reading: [p[0].choice, p[1].choice], mode: st.mode });
    st.mode = "";
  });
  function record(e) { e.n = st.session.length + 1; st.session.push(e); st.cur = e; drawResult(); go("/result"); }

  // ---------------------------------------------------------------- recorded example (same code path)
  function loadRecorded() {
    function use(t) {
      var m = { task: OPEN.task, a: OPEN.options.A, b: OPEN.options.B, priority: OPEN.priority, target: OPEN.target, handoff: t.chain[5] };
      var same = C.prompt(m, false) === t.decisions.delegated.prompt.replace("{{T6_HANDOFF}}", t.chain[5]) &&
                 C.prompt(m, true) === t.decisions.restored.prompt.replace("{{T6_HANDOFF}}", t.chain[5]);
      var ans = [t.decisions.delegated.text, t.decisions.restored.text], p = [C.parse(ans[0]), C.parse(ans[1])];
      st.m = m; st.src = "recorded";
      record({ m: m, src: "recorded", answers: ans, parsed: p, reading: [p[0].choice, p[1].choice], identical: same, mode: "" });
    }
    if (window.__s3bLoaded) { use(window.__s3bLoaded); return; }
    window.__s3bText = function (t) { window.__s3bLoaded = t; use(t); };
    var s = document.createElement("script"); s.src = "assets/s3b/" + encodeURIComponent(OPEN.id) + ".js";
    s.onerror = function () { go("/"); };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- the result
  function say(ch) { return ch === "A" || ch === "B" ? READ[ch] : READ[ch].toLowerCase(); }
  function optText(m, ch) { return ch === "A" ? m.a : ch === "B" ? m.b : ""; }
  function analyse(e) {
    var m = e.m, r = e.reading, o = [C.outcome(r[0], m.target), C.outcome(r[1], m.target)];
    var invalid = r[0] === "INVALID" || r[1] === "INVALID", changed = !invalid && r[0] !== r[1];
    var title = invalid ? "We couldn't read a choice from at least one answer" : changed ? "The choice changed when the priority was repeated" : "Same choice with and without the reminder";
    var shows = invalid ? "Nothing yet: at least one answer had no readable first line. Check how each answer was read, below." :
      changed ? "In this one comparison, the final step chose differently with the priority line added: " + say(r[0]) + " without it, " + say(r[1]) + " with it." :
      "In this one comparison, adding the priority line didn't change the final step's choice (" + say(r[0]) + " both times).";
    var not = ["Whether this is reliable. Answers can vary from run to run, so one pair can differ, or match, by chance.",
               e.src === "own" ? "Anything else about your workflow. The page only read the first line of the two answers you pasted." :
               e.src === "chat" ? "Anything about your workflow. A general chat assistant isn't your final step." :
               e.src === "fictional" ? "Anything about your workflow. This is a made-up example." :
               "Anything about your workflow. This is one recorded run from our pilot.",
               "That the option matching the priority is the better decision."];
    // After a reverse test whose answers both chose the linked option, suggesting "reverse" again would be circular:
    // suggest the swap test if the session has none yet, otherwise a repeat.
    var swapped = st.session.some(function (x) { return x.src === e.src && x.mode === "swap" && sameDecision(x.m, e.m); });
    var sugg = e.src === "recorded" ? "own" : invalid ? "readings" : m.target === "uncertain" ? "edit" : changed ? "again" :
      r[1] === m.target ? (e.mode === "reverse" ? (swapped ? "again" : "swap") : "reverse") : "edit";
    var why = { own: "Bring one decision and one real input from your workflow. You'll get the same two prompts to run through your own final step.",
                readings: "Each answer should start with FIRST CHOICE: A, B or UNCLEAR. You can correct a reading by hand below.",
                edit: m.target === "uncertain" ? "Without a link between the priority and an option, the choices can be compared with each other but not with the priority." :
                      "With the reminder, the step didn't choose the option you linked to the priority. Check that this option really fits the priority, then repeat.",
                again: "One changed pair can happen by chance. Repeating 3 to 5 times shows whether the change is consistent.",
                reverse: "Both answers chose the option you linked to the priority. To see whether the priority is what drives the choice, reverse it and check whether the choice switches.",
                swap: "Both answers chose the option you linked to the reversed priority. Swapping the option order checks whether an option's position, rather than the priority, drives the choice." };
    var TT = { own: "Now try it with your own decision", readings: "Suggested next: check the readings", edit: "Suggested next: check the decision", again: "Suggested next: repeat it", reverse: "Suggested next: reverse the priority", swap: "Suggested next: swap the option order" };
    return { o: o, invalid: invalid, changed: changed, title: title, shows: shows, not: not, sugg: sugg, nextT: TT[sugg], nextD: why[sugg] };
  }
  function sameDecision(a, b) { return a.task === b.task && a.handoff === b.handoff && [a.a, a.b].sort().join("\u0000") === [b.a, b.b].sort().join("\u0000"); }
  // Session summary. Every attempt is counted: attempts are grouped by priority AND option order (never pooled across
  // orders), unreadable answers are reported with their own count instead of being dropped silently, and UNCLEAR is
  // counted separately from either option. Readings corrected by hand are counted and named.
  function sessionFor(e) {
    var rel = st.session.filter(function (x) { return x.src === e.src && x.src !== "recorded" && sameDecision(x.m, e.m); });
    if (!rel.length) return null;
    var base = rel[0].m, lines = [], groups = {}, order = [];
    rel.forEach(function (x) {
      var k = x.m.priority + "\u0000" + (x.m.a === base.a ? "as entered" : "swapped");
      if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(x);
    });
    function tally(xs, i) {
      var t = { A: 0, B: 0, UNCLEAR: 0, INVALID: 0 };
      xs.forEach(function (x) { t[x.reading[i]] = (t[x.reading[i]] || 0) + 1; });
      return "A " + t.A + " · B " + t.B + " · UNCLEAR " + t.UNCLEAR + " · unreadable " + t.INVALID;
    }
    order.forEach(function (k) {
      var xs = groups[k], pr = k.split("\u0000")[0], ord = k.split("\u0000")[1];
      var valid = xs.filter(function (x) { return x.reading.indexOf("INVALID") < 0; }), bad = xs.length - valid.length;
      var corrected = xs.filter(function (x) { return x.reading[0] !== x.parsed[0].choice || x.reading[1] !== x.parsed[1].choice; }).length;
      var ch = valid.filter(function (x) { return x.reading[0] !== x.reading[1]; }).length;
      var t = xs[0].m.target, fit = t === "uncertain" ? null : optText(xs[0].m, t);
      var k2 = fit ? valid.filter(function (x) { return optText(x.m, x.reading[1]) === fit; }).length : null;
      lines.push("Priority “" + short(pr, 60) + "”, options " + ord + ": " + plural(xs.length, "attempt") + "; " + valid.length + " with both answers readable" +
        (bad ? ", " + bad + " with an unreadable answer (shown below, not counted in the comparison)" : "") + (corrected ? "; " + corrected + " with a reading corrected by hand" : "") + ".");
      if (valid.length) lines.push("  Of the " + valid.length + " readable pair" + (valid.length === 1 ? "" : "s") + ", the choice differed in " + ch + " (this includes ordinary run-to-run variation)" +
        (k2 !== null ? "; with the reminder it chose the option you linked (" + short(fit, 40) + ") in " + k2 + "." : "."));
      lines.push("  Without the reminder: " + tally(xs, 0) + ". With the reminder: " + tally(xs, 1) + ".");
    });
    var prios = {}; rel.forEach(function (x) { prios[x.m.priority] = 1; });
    if (Object.keys(prios).length >= 2) lines.push("If the choice follows each priority as you linked them, it switches between the two options when the priority is reversed. Counts this small don't establish a reliable pattern.");
    if (rel.some(function (x) { return x.m.a !== base.a; })) lines.push("Option orders are counted separately; choices are matched by option text, not by letter.");
    return { rows: rel, lines: lines, base: base };
  }
  function drawResult() {
    var e = st.cur, m = e.m, a = analyse(e);
    $("res-steps").hidden = e.src === "recorded";
    $("res-src").textContent = SRCTXT[e.src] + (e.src === "recorded" && e.identical ? " Both prompts are identical to the ones recorded in the study." : "");
    $("res-src").setAttribute("data-source", e.src);
    $("res-h").textContent = a.title;
    $("res-kind").textContent = e.mode === "reverse" ? "Reversed priority" : e.mode === "swap" ? "Priority · options swapped" : e.mode === "again" ? "Priority · repeat" : "Priority";
    $("res-p").textContent = m.priority;
    $("res-fav").textContent = m.target === "uncertain" ? "Fitting option: not sure" : "Favors Option " + m.target + " · " + short(optText(m, m.target), 60);
    [["tile-a", 0], ["tile-b", 1]].forEach(function (t) {
      var el = $(t[0]), ch = e.reading[t[1]];
      el.setAttribute("data-outcome", a.o[t[1]]); el.setAttribute("data-changed", a.changed ? "yes" : "no");
      el.querySelector(".ch").textContent = READ[ch];
      el.querySelector(".opt").textContent = optText(m, ch);
      el.querySelector(".oc").textContent = OC[a.o[t[1]]] + (e.reading[t[1]] !== e.parsed[t[1]].choice ? " · reading corrected by you" : "");
    });
    $("res-shows").textContent = a.shows;
    var ul = clear($("res-not")); a.not.forEach(function (x) { add(ul, h("li", null, x)); });
    var nx = clear($("res-next")); add(nx, h("p", "k", a.nextT)); add(nx, h("p", null, a.nextD));
    var row = add(nx, h("div", "row"));
    if (e.src === "recorded") {
      var b1 = add(row, h("button", "btn sm primary", "Test my own decision")); b1.type = "button"; b1.setAttribute("data-act", "own"); b1.addEventListener("click", function () { act("own"); });
      var b2 = add(row, h("a", "btn sm ghost", "Step through this recorded run")); b2.href = "experiment.html#replay/" + OPEN.id;
    } else if (a.sugg === "readings" || a.sugg === "edit") {
      var b3 = add(row, h("button", "btn sm primary", a.sugg === "readings" ? "Check the readings" : "Edit the decision")); b3.type = "button"; b3.setAttribute("data-act", a.sugg);
      b3.addEventListener("click", function () { act(a.sugg); });
    }
    drawFollow(e, a); drawAttempts(e); drawReadings(e);
    $("res-pa").textContent = C.prompt(m, false); $("res-pb").textContent = C.prompt(m, true); $("res-in").textContent = m.handoff;
    reveal();
  }
  function drawFollow(e, a) {
    var box = clear($("follow-cards")), rec = e.src === "recorded";
    $("follow").hidden = rec;
    if (rec) return;
    var cards = [
      ["again", "Repeat the comparison", "Is the result consistent? One pair of answers can differ, or match, by chance. Repeats are counted below."],
      ["reverse", "Reverse the priority", "Does the choice follow the priority when it flips? You write the reversed priority and confirm which option it favors."],
      ["swap", "Swap the option order", "Does an option's position affect the choice? The options change places; results are matched by option text, not letter."]
    ];
    cards.forEach(function (c) {
      var off = (c[0] === "reverse" || c[0] === "swap") && e.m.target === "uncertain";
      var card = add(box, h("div", "card pad fu"));
      card.setAttribute("data-test", c[0]);
      if (a.sugg === c[0]) add(card, h("span", "tag rec", "Suggested next"));
      add(card, h("h3", null, c[1])); add(card, h("p", "muted small", c[2]));
      var b = add(card, h("button", "btn sm " + (a.sugg === c[0] ? "primary" : "ghost"), off ? "Link an option first" : c[1])); b.type = "button"; b.setAttribute("data-act", off ? "edit" : c[0]);
      b.addEventListener("click", function () { act(off ? "edit" : c[0]); });
    });
  }
  function drawAttempts(e) {
    var body = clear($("attempts-body")), all = st.session.filter(function (x) { return x.src !== "recorded"; });
    $("attempts-n").textContent = all.length ? plural(all.length, "attempt") + " · kept only in this tab" : "None yet";
    if (!all.length) { add(body, h("p", "muted small", "Your comparisons will be listed here.")); return; }
    var wrap = add(body, h("div", "table-wrap")), tb = add(wrap, h("table", "dt")), hr = add(tb, h("tr"));
    ["#", "Test", "Priority", "Order", "Without reminder", "With reminder"].forEach(function (x) { add(hr, h("th", null, x)); });
    all.forEach(function (x) {
      var base = all.filter(function (y) { return sameDecision(y.m, x.m); })[0].m, tr = add(tb, h("tr"));
      [String(x.n), KIND[x.mode || ""], short(x.m.priority, 44), x.m.a === base.a ? "as entered" : "swapped",
       READ[x.reading[0]] + (optText(x.m, x.reading[0]) ? " · " + short(optText(x.m, x.reading[0]), 26) : ""),
       READ[x.reading[1]] + (optText(x.m, x.reading[1]) ? " · " + short(optText(x.m, x.reading[1]), 26) : "")].forEach(function (c) { add(tr, h("td", null, c)); });
    });
    var ses = sessionFor(e);
    if (ses) ses.lines.forEach(function (l) { add(body, h("p", "small", l)); });
    var row = add(body, h("div", "row")), b = add(row, h("button", "btn sm ghost", "Save all attempts (.md)")); b.type = "button"; b.id = "x-all";
    b.addEventListener("click", function () { dl(toMd(true), "priority-comparisons-all.md", "text/markdown"); });
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function drawReadings(e) {
    var rd = clear($("res-read"));
    ["Without reminder", "With reminder"].forEach(function (lab, i) {
      var card = add(rd, h("div", "readcard"));
      add(card, h("p", null, lab + " · first line: " + (e.parsed[i].first ? "“" + e.parsed[i].first + "”" : "(empty)") + " · strict reading: " + READ[e.parsed[i].choice] + "."));
      var l = add(card, h("label", null, "Your reading")), sel = h("select"); sel.setAttribute("data-i", String(i));
      ["A", "B", "UNCLEAR", "INVALID"].forEach(function (k) { var o = add(sel, h("option", null, READ[k])); o.value = k; });
      sel.value = e.reading[i]; add(l, sel);
      sel.addEventListener("change", function () { e.reading[i] = sel.value; drawResult(); $("res-readings").open = true; });
      add(card, h("pre", null, e.answers[i]));
    });
  }
  function reveal() {
    var els = [$("tile-a"), $("tile-b"), document.querySelector(".res-cols"), $("res-next")];
    els.forEach(function (x) { x.classList.add("reveal"); x.classList.remove("in"); });
    if (document.documentElement.getAttribute("data-motion") !== "on") { els.forEach(function (x) { x.classList.add("in"); }); return; }
    els.forEach(function (x, i) { setTimeout(function () { x.classList.add("in"); }, 120 + i * 220); });
  }
  function act(k) {
    var m = st.cur.m;
    if (k === "own") { st.mode = ""; fillForm({}); setRadio("t-where", ""); $("t-rev").hidden = true; notes(); go("/"); }
    else if (k === "readings") { $("res-readings").open = true; $("res-readings").querySelector("select").focus(); }
    else if (k === "edit") { st.mode = ""; fillForm(m); $("t-rev").hidden = true; notes(); go("/"); }
    else if (k === "again") { st.m = JSON.parse(JSON.stringify(m)); st.src = st.cur.src; st.mode = "again"; prepRun("Repeat: the same two prompts. Run each in a fresh session and paste the new answers."); go("/run"); }
    else if (k === "swap") {
      st.m = { task: m.task, a: m.b, b: m.a, priority: m.priority, target: m.target === "A" ? "B" : m.target === "B" ? "A" : m.target, handoff: m.handoff };
      st.src = st.cur.src; st.mode = "swap";
      prepRun("Swapped order: the two options have changed places, so the option you linked to the priority is now Option " + st.m.target + ". Everything else is the same.");
      go("/run");
    } else if (k === "reverse") {
      st.prev = m; st.mode = "reverse";
      fillForm({ task: m.task, a: m.a, b: m.b, handoff: m.handoff, priority: "", target: "" });
      setRadio("t-where", st.cur.src === "own" ? "own" : "chat");
      $("t-rev").hidden = false;
      $("t-rev").textContent = "Reverse test. Previous priority: “" + m.priority + "” (favored Option " + m.target + "). Write the reversed priority and choose the option it favors. Don't assume it's simply the other one.";
      notes(); go("/"); setTimeout(function () { $("t-p").focus(); }, 0);
    }
  }

  // ---------------------------------------------------------------- export: the result first, details after
  function entryBlocks(e, B, P, H, L, PRE) {
    var m = e.m, a = analyse(e);
    H("Result: " + a.title.toLowerCase());
    L(["Test: " + KIND[e.mode || ""] + (e.src !== "recorded" ? " · run through: " + (e.src === "own" ? "your workflow's final step" : e.src === "chat" ? "a general chat assistant (method demo)" : "made-up answers") : ""),
       "Priority: “" + m.priority + "”" + (m.target === "uncertain" ? " (fitting option: not sure)" : " → favors Option " + m.target + ": " + optText(m, m.target)),
       "Without reminder: " + READ[e.reading[0]] + (optText(m, e.reading[0]) ? ": " + optText(m, e.reading[0]) : "") + " (" + OC[a.o[0]].slice(2).toLowerCase() + ")",
       "With reminder: " + READ[e.reading[1]] + (optText(m, e.reading[1]) ? ": " + optText(m, e.reading[1]) : "") + " (" + OC[a.o[1]].slice(2).toLowerCase() + ")"]);
    P("This comparison shows: " + a.shows);
    P("It doesn't show:"); L(a.not);
    return a;
  }
  function blocks(all) {
    var e = st.cur, B = [];
    function P(t) { B.push(["p", t]); } function H(t) { B.push(["h2", t]); } function L(xs) { B.push(["ul", xs]); } function PRE(t) { B.push(["pre", t]); }
    function H3(t) { B.push(["h3", t]); }
    function details(x, head, label) {             // the decision, input, prompts and answers of ONE attempt
      var m = x.m;
      head("Details" + label);
      L(["What's being decided: " + m.task, "Option A: " + m.a, "Option B: " + m.b]);
      P("Final step's input:"); PRE(m.handoff);
      P("Prompt without reminder:"); PRE(C.prompt(m, false));
      P("Prompt with reminder:"); PRE(C.prompt(m, true));
      [0, 1].forEach(function (i) { P("Answer " + (i ? "with" : "without") + " reminder (strict reading: " + READ[x.parsed[i].choice] + (x.reading[i] !== x.parsed[i].choice ? "; corrected by hand to " + READ[x.reading[i]] : "") + "):"); PRE(x.answers[i]); });
    }
    B.push(["h1", all ? "Priority reminder comparisons" : "Priority reminder comparison"]);
    if (all) {
      // v4 review fix: every attempt carries its own source, decision, input, prompts and answers (attempts can come
      // from different sources and decisions), so there is no file-level source line.
      P(new Date().toISOString().slice(0, 10));
      st.session.filter(function (x) { return x.src !== "recorded"; }).forEach(function (x) {
        B.push(["h2", "Attempt " + x.n]); P(SRCTXT[x.src]);
        entryBlocks(x, B, P, H3, L, PRE);
        details(x, H3, " of attempt " + x.n);
      });
      var ses = sessionFor(e); if (ses) { H("Summary for the current decision"); L(ses.lines); }
    } else {
      P(new Date().toISOString().slice(0, 10) + " · " + SRCTXT[e.src]);
      var a = entryBlocks(e, B, P, H, L, PRE);
      H(a.nextT); P(a.nextD);
      var s2 = sessionFor(e); if (s2 && s2.rows.length > 1) { H("This session (same decision and input)"); L(s2.lines); }
      details(e, H, "");
    }
    P("Made with the Anchor-Preservation Auditor, a static page that runs no AI and sent nothing anywhere. It read only the first line of each answer. Not a verified finding about any system.");
    return B;
  }
  function toMd(all) {
    return blocks(all).map(function (b) {
      if (b[0] === "h1") return "# " + b[1];
      if (b[0] === "h2") return "## " + b[1];
      if (b[0] === "h3") return "### " + b[1];
      if (b[0] === "ul") return b[1].map(function (x) { return "- " + x; }).join("\n");
      if (b[0] === "pre") { var f = b[1].indexOf("```") >= 0 ? "~~~~" : "```"; return f + "text\n" + b[1].replace(/\n$/, "") + "\n" + f; }
      return b[1];
    }).join("\n\n") + "\n";
  }
  function toHtml(all) {
    var doc = document.implementation.createHTMLDocument(all ? "Priority reminder comparisons" : "Priority reminder comparison");
    var meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.insertBefore(meta, doc.head.firstChild);
    blocks(all).forEach(function (b) {
      var n;
      if (b[0] === "ul") { n = doc.createElement("ul"); b[1].forEach(function (x) { var li = doc.createElement("li"); li.textContent = x; n.appendChild(li); }); }
      else { n = doc.createElement(b[0] === "pre" ? "pre" : b[0]); n.textContent = b[1]; }
      doc.body.appendChild(n);
    });
    var css = "body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;background:#0b1020;color:#e8edf7}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:22px;color:#67e8f9}h3{font-size:1rem}pre{white-space:pre-wrap;background:#131b33;border:1px solid #26304d;border-radius:8px;padding:8px 10px;font-size:.8rem}";
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace("</head>", "<style>" + css + "</style></head>");
  }
  function dl(text, name, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type })), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    $("x-msg").textContent = "Saved " + name + ".";
  }
  $("x-md").addEventListener("click", function () { dl(toMd(false), "priority-comparison.md", "text/markdown"); });
  $("x-html").addEventListener("click", function () { dl(toHtml(false), "priority-comparison.html", "text/html"); });
  $("x-copy").addEventListener("click", function () {
    var t = toMd(false);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { $("x-msg").textContent = "Copied as Markdown."; }, function () { $("x-msg").textContent = "Copy wasn't allowed here; use Save instead."; });
    else $("x-msg").textContent = "Copy isn't available here; use Save instead.";
  });
  window.__v3 = { md: toMd, html: toHtml, state: st };
  route();
})();
