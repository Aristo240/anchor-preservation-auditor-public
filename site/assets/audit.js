// Audit your own workflow: entirely client-side. No network, no storage, no model, no automatic judgment.
// Everything a visitor types is rendered with textContent only (never parsed as HTML), lives only in this
// page's memory, and is gone on reload unless the visitor exports the summary file themselves.
(function () {
  "use strict";
  var MAX_HANDOFFS = 6;
  var form = document.getElementById("audit-form");
  if (!form) return;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function add(parent) { var last = parent; for (var i = 1; i < arguments.length; i++) if (arguments[i]) last = parent.appendChild(arguments[i]); return last; }
  function radio(name) { var x = form.querySelector('input[name="' + name + '"]:checked'); return x ? x.value : ""; }
  function setRadio(name, v) { Array.prototype.forEach.call(form.querySelectorAll('input[name="' + name + '"]'), function (x) { x.checked = x.value === v; }); }

  // ------------------------------------------------------------ handoff rows
  function addRow(text, role) {
    var box = $("a-handoffs");
    var n = box.children.length + 1;
    if (n > MAX_HANDOFFS) return;
    var row = add(box, h("div", "handoff-row"));
    var head = add(row, h("div", "row-head"));
    var lab = add(head, h("label", null, "Handoff " + n));
    var ta = h("textarea"); ta.maxLength = 20000; ta.id = "a-h" + n; ta.className = "handoff-text";
    lab.htmlFor = ta.id;
    var rm = add(head, h("button", "btn ghost no-print", "Remove")); rm.type = "button";
    rm.setAttribute("aria-label", "Remove handoff " + n);
    rm.addEventListener("click", function () { row.remove(); renumber(); });
    var rl = h("input"); rl.type = "text"; rl.maxLength = 80; rl.className = "handoff-role"; rl.placeholder = "Role (optional), e.g. advisor";
    rl.setAttribute("aria-label", "Role of handoff " + n + " (optional)");
    add(row, rl, ta);
    ta.value = text || ""; rl.value = role || "";
    renumber();
  }
  function renumber() {
    var rows = $("a-handoffs").children;
    Array.prototype.forEach.call(rows, function (row, i) {
      var lab = row.querySelector("label"), ta = row.querySelector("textarea"), rm = row.querySelector("button"), rl = row.querySelector(".handoff-role");
      lab.textContent = "Handoff " + (i + 1); ta.id = "a-h" + (i + 1); lab.htmlFor = ta.id;
      rm.setAttribute("aria-label", "Remove handoff " + (i + 1)); rl.setAttribute("aria-label", "Role of handoff " + (i + 1) + " (optional)");
    });
    $("a-add").disabled = rows.length >= MAX_HANDOFFS;
    $("a-add-hint").textContent = rows.length + " of " + MAX_HANDOFFS + " handoffs";
  }
  function handoffs() {
    return Array.prototype.map.call($("a-handoffs").children, function (row) {
      return { role: row.querySelector(".handoff-role").value.trim(), text: row.querySelector("textarea").value };
    }).filter(function (x) { return x.text.trim(); });
  }

  // ------------------------------------------------------------ literal term highlighting
  function terms() {
    var seen = {};
    return $("a-terms").value.split(",").map(function (t) { return t.trim(); })
      .filter(function (t) { var k = t.toLowerCase(); if (!t || seen[k]) return false; seen[k] = 1; return true; }).slice(0, 20);
  }
  function termRe(ts) {
    if (!ts.length) return null;
    return new RegExp(ts.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).sort(function (a, b) { return b.length - a.length; }).join("|"), "gi");
  }
  function countTerm(text, t) {
    var re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m = text.match(re);
    return m ? m.length : 0;
  }
  function highlighted(text, re) {
    var box = h("div", "text-box");
    box.tabIndex = 0;
    text.split(/\n{2,}/).forEach(function (para) {
      var p = add(box, h("p"));
      p.style.whiteSpace = "pre-wrap";
      if (!re) { p.textContent = para; return; }
      re.lastIndex = 0;
      var last = 0, m;
      while ((m = re.exec(para)) !== null) {
        if (m.index > last) p.appendChild(document.createTextNode(para.slice(last, m.index)));
        add(p, h("mark", "term", m[0]));
        last = m.index + m[0].length;
        if (!m[0].length) re.lastIndex++;
      }
      if (last < para.length) p.appendChild(document.createTextNode(para.slice(last)));
    });
    return box;
  }

  // ------------------------------------------------------------ the audit view
  var OUT = { matched: ["✓", "The final choice matched the option you identified with the priority"],
              opposite: ["⇄", "The final choice was the other option"],
              unclear: ["?", "The final answer chose neither option"],
              uncertain: ["–", "No comparison: you marked the mapping as uncertain"] };
  var model = null;
  function read() {
    return { task: $("a-task").value, a: $("a-opt-a").value, b: $("a-opt-b").value, priority: $("a-priority").value,
             target: radio("target"), handoffs: handoffs(), final: $("a-final").value, choice: radio("choice"), terms: terms() };
  }
  // the same validation as before, grouped by the step that collects each field
  function problems(m, step) {
    var p = [];
    if (!step || step === 1) {
      if (!m.task.trim()) p.push("the decision");
      if (!m.a.trim() || !m.b.trim()) p.push("both options");
      if (!m.priority.trim()) p.push("the stated priority");
      if (!m.target) p.push("which option corresponds to the priority (or uncertain)");
    }
    if ((!step || step === 2) && !m.handoffs.length) p.push("at least one handoff");
    if ((!step || step === 3) && !m.choice) p.push("which option the final answer chose");
    return p;
  }

  // ------------------------------------------------------------ the four guided steps
  var stepNow = 1, stepMax = 1;
  function showStep(n, focus) {
    stepNow = n; stepMax = Math.max(stepMax, n);
    Array.prototype.forEach.call(form.querySelectorAll(".a-step"), function (sec) { sec.hidden = Number(sec.getAttribute("data-step")) !== n; });
    Array.prototype.forEach.call(document.querySelectorAll("#a-steps button"), function (b) {
      var k = Number(b.getAttribute("data-goto"));
      if (k === n) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
      b.disabled = k > stepMax;
    });
    $("a-back").disabled = n === 1;
    $("a-next").hidden = n === 4;
    if (focus) { var hd = form.querySelector('.a-step[data-step="' + n + '"] h2'); if (hd) hd.focus(); }
  }
  function next() {
    var p = problems(read(), stepNow);
    if (p.length) { $("a-err").textContent = "Please add: " + p.join("; ") + "."; return; }
    $("a-err").textContent = "";
    showStep(Math.min(4, stepNow + 1), true);
  }
  function outcomeOf(m) {
    if (m.target === "uncertain") return "uncertain";
    if (m.choice === "none") return "unclear";
    return m.choice === m.target ? "matched" : "opposite";
  }
  function badge(o) {
    var b = h("span", "oc " + (o === "matched" ? "oc-matched" : o === "opposite" ? "oc-opposite" : o === "unclear" ? "oc-unclear" : "oc-none"));
    add(b, h("span", "sym", OUT[o][0]), document.createTextNode(OUT[o][1]));
    b.setAttribute("data-outcome", o);
    return b;
  }
  function show() {
    var m = read(), p = problems(m), err = $("a-err"), out = $("a-out");
    if (p.length) { err.textContent = "Please add: " + p.join("; ") + "."; out.hidden = true; return; }
    $("a-steps").classList.add("done");
    err.textContent = "";
    model = m;
    var re = termRe(m.terms), o = outcomeOf(m);
    out.replaceChildren();
    out.hidden = false;
    add(out, h("h2", null, "Audit summary"));
    add(out, h("p", "label-note", "An observation, not a verdict. The Auditor compares the final choice with the option you declared; you decide whether any departure is a problem."));
    add(out, h("p", "lab", "Decision"), h("p", null, m.task));
    var g = add(out, h("div", "options"));
    [["A", m.a], ["B", m.b]].forEach(function (x) {
      var d = add(g, h("div", "opt" + (m.target === x[0] ? " target" : "")));
      add(d, h("span", "k", "Option " + x[0]), document.createTextNode(x[1]));
      if (m.target === x[0]) add(d, h("span", "tag", "You identified this option with the priority"));
    });
    if (m.target === "uncertain") add(out, h("p", "small", "You marked the option–priority mapping as uncertain."));
    add(out, h("p", "lab", "Stated priority"), h("blockquote", "priority-quote", m.priority));
    var res = add(out, h("p", "totals")); res.id = "a-result"; add(res, badge(o));
    var chosen = m.choice === "none" ? "neither option" : "Option " + m.choice;
    add(out, h("p", "small", "Final answer chose: " + chosen + " (as you recorded it)."));

    add(out, h("h3", null, "Priority terms across the handoffs (literal matching only)"));
    if (!m.terms.length) add(out, h("p", "small", "No terms entered. Add comma-separated words or phrases above to see where they appear."));
    else {
      add(out, h("p", "small", "Counts of the exact strings you entered, ignoring case. A term can be absent while its meaning is present, and present without influencing anything."));
      var tb = add(out, h("table", "term-table"));
      var hr = add(add(tb, h("thead")), h("tr"));
      add(hr, h("th", null, "Text"));
      m.terms.forEach(function (t) { add(hr, h("th", null, "“" + t + "”")); });
      var body = add(tb, h("tbody"));
      m.handoffs.concat([{ role: "final answer", text: m.final, final: true }]).forEach(function (x, i) {
        var tr = add(body, h("tr"));
        add(tr, h("td", null, x.final ? "Final answer" : "Handoff " + (i + 1) + (x.role ? " (" + x.role + ")" : "")));
        m.terms.forEach(function (t) { add(tr, h("td", null, String(countTerm(x.text, t)))); });
      });
    }
    add(out, h("h3", null, "The handoffs"));
    m.handoffs.forEach(function (x, i) {
      var d = add(out, h("div", "answer"));
      add(add(d, h("div", "answer-head")), h("span", "cond", "Handoff " + (i + 1) + (x.role ? " · " + x.role : "")));
      add(d, highlighted(x.text, re));
    });
    if (m.final.trim()) {
      var f = add(out, h("div", "answer"));
      var fh = add(f, h("div", "answer-head")); add(fh, h("span", "cond", "Final recorded answer")); fh.appendChild(badge(o));
      add(f, highlighted(m.final, re));
    }

    add(out, h("h3", null, "Your judgment (optional)"));
    var fs = add(out, h("fieldset", "no-print-when-empty")); fs.id = "a-judge";
    add(fs, h("legend", null, "Does this departure require review?"));
    ["Yes", "No", "Unsure"].forEach(function (v) {
      var l = add(fs, h("label")); var r = h("input"); r.type = "radio"; r.name = "judge"; r.value = v; add(l, r, document.createTextNode(" " + v));
    });
    var nl = add(out, h("label", null, "Note (optional)")); nl.className = "form-grid";
    var note = h("textarea"); note.id = "a-note"; note.maxLength = 2000; nl.appendChild(note);
    add(out, h("p", "fine", "Your judgment stays in this page. It is not sent anywhere and is not collected as research data."));
    var bar = add(out, h("div", "no-print"));
    var ex = add(bar, h("button", "btn", "Export a one-page summary (HTML file)")); ex.type = "button"; ex.id = "a-export";
    ex.addEventListener("click", exportSummary);
    bar.appendChild(document.createTextNode(" "));
    var pr = add(bar, h("button", "btn ghost", "Print or save as PDF")); pr.type = "button";
    pr.addEventListener("click", function () { window.print(); });
    out.scrollIntoView({ block: "start" });
  }

  // ------------------------------------------------------------ export: a self-contained file, built with DOM APIs
  function exportSummary() {
    if (!model) return;
    var m = model, o = outcomeOf(m);
    var doc = document.implementation.createHTMLDocument("Audit summary");
    var meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.appendChild(meta);
    var css = "body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1d1f23}" +
      "h1{font-size:1.3rem}h2{font-size:1rem;margin-top:18px}.box{border:1px solid #ccc;border-radius:6px;padding:8px 10px;margin:6px 0;white-space:pre-wrap}" +
      "table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:3px 10px 3px 0;text-align:left}.note{color:#555;font-size:.85rem}";
    function e(tag, text, cls) { var n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; doc.body.appendChild(n); return n; }
    e("h1", "Workflow audit summary");
    e("p", "Exported from the Anchor-Preservation Auditor (static, client-side). An observation, not a verdict: it compares the final choice with the option the person running the audit declared. Term matching is literal.", "note");
    e("h2", "Decision"); e("div", m.task, "box");
    e("h2", "Options"); e("div", "A: " + m.a + "\nB: " + m.b, "box");
    e("h2", "Stated priority"); e("div", m.priority, "box");
    e("h2", "Declared target option"); e("p", m.target === "uncertain" ? "Uncertain" : "Option " + m.target);
    e("h2", "Final recorded choice"); e("p", m.choice === "none" ? "Neither / unclear" : "Option " + m.choice);
    e("h2", "Observation"); e("p", OUT[o][1]);
    if (m.terms.length) {
      e("h2", "Literal term counts");
      var t = e("table"), hr = doc.createElement("tr"); t.appendChild(hr);
      [""].concat(m.terms).forEach(function (x) { var th = doc.createElement("th"); th.textContent = x; hr.appendChild(th); });
      m.handoffs.concat([{ text: m.final, final: true }]).forEach(function (x, i) {
        var tr = doc.createElement("tr"); t.appendChild(tr);
        var td = doc.createElement("td"); td.textContent = x.final ? "Final answer" : "Handoff " + (i + 1); tr.appendChild(td);
        m.terms.forEach(function (term) { var c = doc.createElement("td"); c.textContent = String(countTerm(x.text, term)); tr.appendChild(c); });
      });
    }
    var jEl = document.querySelector('input[name="judge"]:checked');
    e("h2", "Reviewer judgment: does this departure require review?");
    e("p", jEl ? jEl.value : "Not answered");
    var note = $("a-note") ? $("a-note").value : "";
    if (note.trim()) e("div", note, "box");
    e("h2", "Handoffs (" + m.handoffs.length + ")");
    m.handoffs.forEach(function (x, i) { e("p", "Handoff " + (i + 1) + (x.role ? " (" + x.role + ")" : ""), "note"); e("div", x.text, "box"); });
    if (m.final.trim()) { e("h2", "Final recorded answer"); e("div", m.final, "box"); }
    // the fixed stylesheet is added as a string (it holds no visitor text); every visitor string went in via textContent
    var html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace("</head>", "<style>" + css + "</style></head>");
    var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    var a = document.createElement("a"); a.href = url; a.download = "workflow-audit-summary.html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ------------------------------------------------------------ a fictional example (written for this page, not a model output)
  var DEMO = {
    task: "A team lead must choose the venue for a two-day team offsite.",
    a: "A quiet countryside retreat with structured work sessions.",
    b: "A city hotel close to museums, restaurants and nightlife.",
    priority: "For this offsite, uninterrupted focus time matters more to me than entertainment options.",
    target: "A",
    handoffs: [
      ["advisor", "You said uninterrupted focus time matters most. The countryside retreat is built for that: structured sessions and few distractions. I recommend Option A."],
      ["critic", "The advice is consistent with the stated priority, but it ignores team morale. A city venue offers variety that could keep people energised."],
      ["summarizer", "Option A supports focus; Option B supports morale and variety. The choice depends on which matters more for this team."],
      ["advisor", "Given the trade-off, a city hotel with a reserved quiet room might give the team both energy and some focus."],
      ["critic", "That compromise is reasonable, though a city setting makes it harder to protect focus time."],
      ["summarizer", "Overall, the city hotel offers the broadest benefits for the team, with a quiet room for focused work."]
    ],
    final: "FIRST CHOICE: B\nThe city hotel offers the broadest benefits for team morale, with a quiet room for focus.",
    choice: "B",
    terms: "focus, uninterrupted"
  };
  function fill(x) {
    $("a-task").value = x.task; $("a-opt-a").value = x.a; $("a-opt-b").value = x.b; $("a-priority").value = x.priority;
    setRadio("target", x.target);
    $("a-handoffs").replaceChildren();
    x.handoffs.forEach(function (r) { addRow(r[1], r[0]); });
    $("a-final").value = x.final; setRadio("choice", x.choice); $("a-terms").value = x.terms;
  }
  function loadDemo() {
    clearAll(); fill(DEMO);
    stepMax = 4; showStep(4);
    show();
    $("a-err").textContent = "Loaded the fictional example (written for this page, not a recorded AI output). Use the steps above to see or change each part.";
  }

  // ------------------------------------------------------------ load a recorded Study 3B case (local files only)
  function loadExample() {
    var S = window.STUDY3B; if (!S) return;
    var id = S.selection.opening_case, c = S.cases.filter(function (x) { return x.id === id; })[0];
    window.__s3bText = function (t) {
      clearAll();
      $("a-task").value = c.task; $("a-opt-a").value = c.options.A; $("a-opt-b").value = c.options.B; $("a-priority").value = c.priority;
      setRadio("target", c.target);
      $("a-handoffs").replaceChildren();
      var roles = ["advisor", "critic", "summarizer", "advisor", "critic", "summarizer"];
      t.chain.forEach(function (x, i) { addRow(x, roles[i]); });
      $("a-final").value = t.decisions.delegated.text;
      var ch = c.choices.delegated; setRadio("choice", ch === "ABSTAIN" ? "none" : ch);
      $("a-terms").value = c.focal_value;
      stepMax = 4; showStep(4);
      show();
      $("a-err").textContent = "Loaded recorded Study 3B case " + id + " (the handoff-only condition: six recorded handoffs, then the recorded final answer). Use the steps above to see each part.";
    };
    var s = document.createElement("script"); s.src = "assets/s3b/" + encodeURIComponent(id) + ".js";
    s.onerror = function () { $("a-err").textContent = "The example could not be loaded."; };
    document.head.appendChild(s);
  }
  function clearAll() {
    form.reset();
    $("a-handoffs").replaceChildren(); addRow();
    $("a-out").replaceChildren(); $("a-out").hidden = true; $("a-err").textContent = ""; model = null;
    stepMax = 1; showStep(1);
  }

  $("a-add").addEventListener("click", function () { addRow(); var r = $("a-handoffs").lastChild; if (r) r.querySelector("textarea").focus(); });
  $("a-run").addEventListener("click", show);
  $("a-load").addEventListener("click", loadExample);
  $("a-demo").addEventListener("click", loadDemo);
  $("a-own").addEventListener("click", function () { clearAll(); showStep(1, true); });

  // ------------------------------------------------------------ start from a Workflow Map file (validated by wfmap.js; never executed)
  function loadMap(m) {
    clearAll();
    $("a-task").value = m.test.question || m.decision; $("a-opt-a").value = m.test.option_a; $("a-opt-b").value = m.test.option_b;
    $("a-priority").value = m.priority; setRadio("target", m.test.priority_favours);
    $("a-handoffs").replaceChildren();
    var hs = m.agents.filter(function (a) { return a.decision_role !== "final"; });
    hs.slice(0, MAX_HANDOFFS).forEach(function (a) { addRow("", a.name + (a.role ? " · " + a.role : "")); });
    if (!hs.length) addRow();
    showStep(1, true);
    $("a-err").textContent = "Filled in from the map: " + Math.min(hs.length, MAX_HANDOFFS) + " empty handoff(s), one per agent" +
      (hs.length > MAX_HANDOFFS ? " (only the first " + MAX_HANDOFFS + " fit this review)" : "") + ". Paste what each agent actually wrote in step 2.";
  }
  if ($("a-map-file") && window.APAWorkflowMap) $("a-map-file").addEventListener("change", function () {
    var f = this.files && this.files[0]; this.value = "";
    if (!f) return;
    if (f.size > 400000) { $("a-err").textContent = "That file is too large to be a workflow map."; return; }
    var rd = new FileReader();
    rd.onload = function () {
      var x; try { x = JSON.parse(String(rd.result)); } catch (e) { $("a-err").textContent = "That file is not valid JSON."; return; }
      var v = window.APAWorkflowMap.validate(x);
      if (!v.ok) { $("a-err").textContent = "The map file was not opened: " + v.errors.slice(0, 5).join("; ") + "."; return; }
      loadMap(v.map);
    };
    rd.onerror = function () { $("a-err").textContent = "The file could not be read."; };
    rd.readAsText(f);
  });
  $("a-clear").addEventListener("click", clearAll);
  $("a-next").addEventListener("click", next);
  $("a-back").addEventListener("click", function () { $("a-err").textContent = ""; showStep(Math.max(1, stepNow - 1), true); });
  Array.prototype.forEach.call(document.querySelectorAll("#a-steps button"), function (b) {
    b.addEventListener("click", function () { var k = Number(b.getAttribute("data-goto")); if (k <= stepMax) { $("a-err").textContent = ""; showStep(k, true); } });
  });
  form.addEventListener("submit", function (ev) { ev.preventDefault(); });
  clearAll();
})();
