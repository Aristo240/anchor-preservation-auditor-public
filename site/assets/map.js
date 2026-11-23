// Workflow Map page: entirely client-side. No network, no storage, no model. Visitor text is rendered with
// textContent only (never parsed as HTML) and lives only in this page's memory unless the visitor exports a file.
// The rules are in wfmap.js; this file only builds the form, draws the map and writes the exports.
(function () {
  "use strict";
  var W = window.APAWorkflowMap;
  var form = document.getElementById("map-form");
  if (!form || !W) return;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function add(parent) { var last = parent; for (var i = 1; i < arguments.length; i++) if (arguments[i]) last = parent.appendChild(arguments[i]); return last; }

  var M = W.blank();
  var recorded = null;          // set only by the study example: the recorded results of that exact case
  var BADGE = {
    explicit: ["x-explicit", "● Given directly"],
    via: ["x-via", "◐ Only through outputs"],
    none: ["x-none", "○ No declared route"],
    unknown: ["x-unknown", "? Not specified"]
  };

  // ------------------------------------------------------------ the agent form (rebuilt only when the structure changes)
  function radios(fs, name, value, choices, onPick) {
    choices.forEach(function (c) {
      var l = add(fs, h("label")), r = h("input");
      r.type = "radio"; r.name = name; r.value = c[0]; r.checked = value === c[0];
      r.addEventListener("change", function () { onPick(c[0]); });
      add(l, r, document.createTextNode(" " + c[1]));
    });
  }
  function agentCard(a, i) {
    var card = h("fieldset", "wf-agent"); card.id = "m-agent-" + (i + 1);
    add(card, h("legend", null, "Agent " + (i + 1)));
    var top = add(card, h("div", "wf-agent-top"));
    var ln = add(top, h("label", null, "Name")), name = h("input"); name.type = "text"; name.maxLength = 80; name.value = a.name;
    name.id = "m-name-" + (i + 1); ln.htmlFor = name.id; ln.appendChild(name);
    name.addEventListener("input", function () { a.name = name.value; refreshLabels(); draw(); });
    var lr = add(top, h("label", null, "Role (optional)")), role = h("input"); role.type = "text"; role.maxLength = 80; role.value = a.role;
    role.placeholder = "e.g. planner, critic, summarizer"; role.id = "m-role-" + (i + 1); lr.htmlFor = role.id; lr.appendChild(role);
    role.addEventListener("input", function () { a.role = role.value; draw(); });
    var li = add(card, h("label", null, "Instructions or prompt template (optional)"));
    add(li, h("span", "hint", "Stays in this tab. Used only for a literal hint: if it contains your priority's exact words or a {priority} placeholder, the map asks you to confirm."));
    var ins = h("textarea"); ins.maxLength = 20000; ins.value = a.instructions; ins.id = "m-ins-" + (i + 1); li.htmlFor = ins.id; li.appendChild(ins);
    ins.addEventListener("input", function () { a.instructions = ins.value; draw(); });

    var f1 = add(card, h("fieldset", "wf-q")); add(f1, h("legend", null, "Does it receive the user's priority directly (in its prompt or input)?"));
    radios(f1, "gp-" + i, a.gets_priority, [["yes", "Yes"], ["no", "No"], ["unknown", "Not sure"]], function (v) { a.gets_priority = v; draw(); });

    var f2 = add(card, h("fieldset", "wf-q")); add(f2, h("legend", null, "Does it receive the output of earlier agents?"));
    if (i === 0) {
      add(f2, h("p", "fine", "It is the first agent, so there are no earlier outputs."));
      a.inputs_from = "none"; a.sources = [];
    } else {
      radios(f2, "in-" + i, a.inputs_from, [["some", "Yes"], ["none", "No"], ["unknown", "Not sure"]], function (v) {
        a.inputs_from = v; if (v !== "some") a.sources = []; renderAgents(i); draw();
      });
      if (a.inputs_from === "some") {
        var srcBox = add(f2, h("div", "wf-sources")); add(srcBox, h("p", "fine", "Which agents' outputs does it receive? Tick at least one:"));
        for (var s = 0; s < i; s++) (function (s) {
          var l = add(srcBox, h("label")), c = h("input"); c.type = "checkbox"; c.value = String(s); c.checked = a.sources.indexOf(s) >= 0;
          c.className = "src-" + i;
          c.addEventListener("change", function () {
            var k = a.sources.indexOf(s);
            if (c.checked && k < 0) a.sources.push(s); else if (!c.checked && k >= 0) a.sources.splice(k, 1);
            a.sources.sort(function (x, y) { return x - y; }); draw();
          });
          add(l, c, h("span", "src-name", " " + W.agentLabel(M, s)));
        })(s);
      }
    }
    var f3 = add(card, h("fieldset", "wf-q")); add(f3, h("legend", null, "Does it have other context that could state the priority (memory, a shared document, retrieved files, a system prompt)?"));
    radios(f3, "oc-" + i, a.other_context, [["yes", "Yes"], ["no", "No"], ["unknown", "Not sure"]], function (v) { a.other_context = v; renderAgents(i); draw(); });
    if (a.other_context === "yes") {
      var lo = add(f3, h("label", "wf-note", "What context? (optional)")), oc = h("input"); oc.type = "text"; oc.maxLength = 1000; oc.value = a.other_context_note;
      oc.id = "m-oc-" + (i + 1); lo.htmlFor = oc.id; lo.appendChild(oc);
      oc.addEventListener("input", function () { a.other_context_note = oc.value; draw(); });
    }
    var f4 = add(card, h("fieldset", "wf-q")); add(f4, h("legend", null, "Its part in the final decision"));
    radios(f4, "dr-" + i, a.decision_role, [["final", "Makes the final decision"], ["contributes", "Contributes to it"], ["no", "Neither"], ["unknown", "Not sure"]],
      function (v) { a.decision_role = v; draw(); });

    var rm = add(card, h("button", "btn ghost no-print", "Remove agent " + (i + 1))); rm.type = "button";
    rm.disabled = M.agents.length <= 1;
    rm.addEventListener("click", function () { removeAgent(i); });
    return card;
  }
  function renderAgents(focusIdx) {
    var box = $("m-agents"), active = document.activeElement, keep = active && active.name ? active.name + "|" + active.value : null;
    box.replaceChildren();
    M.agents.forEach(function (a, i) { box.appendChild(agentCard(a, i)); });
    $("m-add").disabled = M.agents.length >= W.MAX_AGENTS;
    $("m-add-hint").textContent = M.agents.length + " of " + W.MAX_AGENTS + " agents";
    if (keep !== null) {   // keep keyboard focus on the radio the visitor just used
      var p = keep.split("|"), el = box.querySelector('input[name="' + p[0] + '"][value="' + p[1] + '"]');
      if (el) el.focus();
    }
  }
  function refreshLabels() {
    Array.prototype.forEach.call(document.querySelectorAll(".src-name"), function (n) {
      var c = n.parentNode.querySelector("input"); n.textContent = " " + W.agentLabel(M, Number(c.value));
    });
  }
  function removeAgent(i) {
    M.agents.splice(i, 1);
    M.agents.forEach(function (a, j) {
      if (j < i) return;
      a.sources = a.sources.filter(function (s) { return s !== i; }).map(function (s) { return s > i ? s - 1 : s; });
    });
    if (M.agents.length && M.agents[0].inputs_from !== "none") { M.agents[0].inputs_from = "none"; M.agents[0].sources = []; }
    renderAgents(); draw();
  }

  // ------------------------------------------------------------ the map, drawn from the declared structure
  function draw() {
    var R = W.analyse(M), flow = $("m-flow");
    flow.replaceChildren();
    var u = add(flow, h("li", "wf-node wf-user"));
    add(u, h("p", "wf-n", "User"));
    add(u, h("p", "wf-pri", M.priority.trim() ? "Priority: " + M.priority.trim() : "Priority: (not entered yet)"));
    M.agents.forEach(function (a, i) {
      var r = R.agents[i], li = add(flow, h("li", "wf-node " + BADGE[r.exposure][0])); li.id = "m-node-" + (i + 1);
      var head = add(li, h("p", "wf-n", (i + 1) + ". " + (a.name || "Agent " + (i + 1)) + (a.role ? " · " + a.role : "")));
      if (a.decision_role === "final") add(head, h("span", "wf-final", "final decision"));
      else if (a.decision_role === "contributes") add(head, h("span", "wf-contrib", "contributes"));
      var b = add(li, h("p", "wf-badge " + BADGE[r.exposure][0], BADGE[r.exposure][1]));
      b.setAttribute("data-exposure", r.exposure);
      var gets = [];
      if (a.gets_priority === "yes") gets.push("the priority, directly");
      if (a.inputs_from === "some" && a.sources.length) gets.push("output of " + a.sources.map(function (s) { return "agent " + (s + 1); }).join(", "));
      if (a.other_context === "yes") gets.push("other context" + (a.other_context_note ? ": " + a.other_context_note : ""));
      add(li, h("p", "wf-gets", "Receives: " + (gets.length ? gets.join("; ") : "nothing declared")));
      r.reasons.forEach(function (t) { add(li, h("p", "wf-why", t)); });
    });

    var fb = $("m-findings"); fb.replaceChildren();
    add(fb, h("h3", null, "What the map shows"));
    var ul = add(fb, h("ul", "wf-findings"));
    if (!R.findings.length) add(ul, h("li", null, "Nothing to report yet."));
    R.findings.forEach(function (f) { var li = add(ul, h("li", "wf-f-" + f.kind, f.text)); li.setAttribute("data-kind", f.kind); });
    if (R.questions.length) {
      add(fb, h("h3", null, "Questions to answer (" + R.questions.length + ")"));
      var ql = add(fb, h("ul", "wf-questions"));
      R.questions.forEach(function (q) {
        var li = add(ql, h("li")), a = add(li, h("a", null, q.text)); a.href = "#m-agent-" + (q.agent + 1);
      });
    } else {
      add(fb, h("p", "fine", "Every question is answered for this map."));
    }
    add(fb, h("p", "fine", "These are structural observations from what you declared. They don't show what any model did, and a priority that isn't literally repeated may still be carried in other words."));

    var rb = $("m-recorded"); rb.replaceChildren();
    if (recorded) {
      add(rb, h("h3", null, "Recorded result for this exact workflow and case"));
      var t = add(rb, h("table", "wf-rec")), hr = add(t, h("tr"));
      ["Condition", "The final decision received", "Recorded choice", "Matches the priority?"].forEach(function (x) { add(hr, h("th", null, x)); });
      recorded.rows.forEach(function (r) { var tr = add(t, h("tr")); r.forEach(function (x) { add(tr, h("td", null, x)); }); });
      add(rb, h("p", "fine", recorded.note));
    }
  }

  // ------------------------------------------------------------ fill the form from a map
  function syncFields() {
    $("m-priority").value = M.priority; $("m-decision").value = M.decision; $("m-title").value = M.title;
    $("t-question").value = M.test.question; $("t-a").value = M.test.option_a; $("t-b").value = M.test.option_b; $("t-opp").value = M.test.opposite_priority;
    Array.prototype.forEach.call(document.querySelectorAll('input[name="t-fav"]'), function (r) { r.checked = r.value === M.test.priority_favours; });
  }
  function load(map, rec) {
    M = map; recorded = rec || null;
    syncFields(); renderAgents(); draw();
    $("t-err").textContent = ""; $("t-cmd").hidden = true;
  }

  // ------------------------------------------------------------ the study's six-handoff workflow, with one recorded case
  function loadExample() {
    var S = window.STUDY3B; if (!S) { $("m-err").textContent = "The recorded study data could not be loaded."; return; }
    var id = S.selection.opening_case, c = S.cases.filter(function (x) { return x.id === id; })[0];
    var opp = S.cases.filter(function (x) { return x.scenario === c.scenario && x.order === c.order && x.priority_index !== c.priority_index; })[0];
    var roles = ["advisor", "critic", "summarizer", "advisor", "critic", "summarizer"];
    var m = W.blank(); m.title = "Study 3B pilot workflow (" + c.title + ")"; m.priority = c.priority; m.decision = c.task; m.agents = [];
    roles.forEach(function (r, i) {
      var a = W.blankAgent(i + 1); a.name = "Handoff " + (i + 1); a.role = r;
      a.instructions = i === 0 ? "Advise the user on the decision. Receives the task, both options and the user's priority." :
        "Respond to the previous handoff as a " + r + ". Receives only the previous handoff's text.";
      a.gets_priority = i === 0 ? "yes" : "no"; a.inputs_from = i === 0 ? "none" : "some"; a.sources = i === 0 ? [] : [i - 1];
      a.other_context = "no"; a.decision_role = "contributes";
      m.agents.push(a);
    });
    var d = W.blankAgent(7); d.name = "Final decision"; d.role = "decider";
    d.instructions = "Choose option A or B for the user. Receives the task, both options and handoff 6; the priority is not repeated (the Delegated condition).";
    d.gets_priority = "no"; d.inputs_from = "some"; d.sources = [5]; d.other_context = "no"; d.decision_role = "final";
    m.agents.push(d);
    m.test = { question: c.task, option_a: c.options.A, option_b: c.options.B, priority_favours: c.target, opposite_priority: opp ? opp.priority : "" };
    function yn(o) { return o === "matched" ? "Yes" : o === "opposite" ? "No, the other option" : "Unclear"; }
    var C = S.counts;
    load(m, {
      rows: [
        ["Direct", "the priority, no handoff", "Option " + c.choices.direct, yn(c.outcomes.direct)],
        ["Delegated (this map)", "handoff 6 only", "Option " + c.choices.delegated, yn(c.outcomes.delegated)],
        ["Restored", "handoff 6 plus one line repeating the priority", "Option " + c.choices.restored, yn(c.outcomes.restored)]
      ],
      note: "Recorded with " + S.model + " in the Study 3B pilot (case " + c.id + "). " + S.selection.opening_label +
        " Across all " + S.n_cases + " recorded cases the choice matched the priority in " + C.direct.matched + " Direct, " +
        C.delegated.matched + " Delegated and " + C.restored.matched + " Restored decisions. Seven constructed decisions, one model: it can't show how often this happens in other workflows."
    });
    $("m-err").textContent = "Loaded the study's six-handoff workflow with recorded case " + c.id + ". The agent descriptions summarise the study's prompts; the exact prompts are in priority_check chain.";
  }

  // ------------------------------------------------------------ import (read as text, parsed as JSON, validated strictly)
  $("m-import").addEventListener("change", function () {
    var f = this.files && this.files[0]; this.value = "";
    if (!f) return;
    if (f.size > 400000) { $("m-err").textContent = "That file is too large to be a workflow map."; return; }
    var rd = new FileReader();
    rd.onload = function () {
      var x; try { x = JSON.parse(String(rd.result)); } catch (e) { $("m-err").textContent = "That file is not valid JSON."; return; }
      var v = W.validate(x);
      if (!v.ok) { $("m-err").textContent = "The file was not opened: " + v.errors.slice(0, 5).join("; ") + (v.errors.length > 5 ? " (and " + (v.errors.length - 5) + " more)" : "") + "."; return; }
      load(v.map, null);
      $("m-err").textContent = "Opened " + f.name + " (" + v.map.agents.length + " agents).";
    };
    rd.onerror = function () { $("m-err").textContent = "The file could not be read."; };
    rd.readAsText(f);
  });

  // ------------------------------------------------------------ exports
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function fileSlug() { return ((M.title || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "workflow"; }
  $("m-export-json").addEventListener("click", function () {
    var v = W.validate(JSON.parse(JSON.stringify(M)));
    if (!v.ok) { $("m-err").textContent = "Not saved: " + v.errors.slice(0, 3).join("; ") + "."; return; }
    download(fileSlug() + ".workflow-map.json", JSON.stringify(v.map, null, 1) + "\n", "application/json");
    $("m-err").textContent = "Saved the map as a .json file.";
  });
  $("m-export-report").addEventListener("click", function () {
    var R = W.analyse(M);
    var doc = document.implementation.createHTMLDocument("Workflow map report");
    var meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.appendChild(meta);
    var css = "body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1d1f23}" +
      "h1{font-size:1.3rem}h2{font-size:1rem;margin-top:18px}.box{border:1px solid #ccc;border-radius:6px;padding:8px 10px;margin:6px 0;white-space:pre-wrap}" +
      ".note{color:#555;font-size:.85rem}li{margin:4px 0}";
    function e(tag, text, cls, parent) { var n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; (parent || doc.body).appendChild(n); return n; }
    e("h1", "Workflow map" + (M.title ? ": " + M.title : ""));
    e("p", "Exported from the Anchor-Preservation Auditor's Workflow Map (static, client-side). It applies fixed rules to the structure the person declared. It does not show what any model did, and it is not a test result.", "note");
    e("h2", "Priority"); e("div", M.priority || "(not entered)", "box");
    if (M.decision) { e("h2", "Decision"); e("div", M.decision, "box"); }
    e("h2", "Agents (" + M.agents.length + ")");
    var LAB = { explicit: "Given directly", via: "Only through outputs or other context", none: "No declared route", unknown: "Not specified" };
    var ol = e("ol");
    M.agents.forEach(function (a, i) {
      var li = e("li", undefined, undefined, ol), r = R.agents[i];
      e("b", (a.name || "Agent " + (i + 1)) + (a.role ? " (" + a.role + ")" : ""), undefined, li);
      e("div", "Priority exposure: " + LAB[r.exposure] + (a.decision_role === "final" ? " · makes the final decision" : ""), undefined, li);
      r.reasons.forEach(function (t) { e("div", t, "note", li); });
    });
    e("h2", "What the map shows");
    var ul = e("ul"); R.findings.forEach(function (f) { e("li", f.text, undefined, ul); });
    if (R.questions.length) { e("h2", "Open questions"); var ql = e("ul"); R.questions.forEach(function (q) { e("li", q.text, undefined, ql); }); }
    if (recorded) {
      e("h2", "Recorded result for this exact workflow and case");
      var ul2 = e("ul"); recorded.rows.forEach(function (r) { e("li", r[0] + ": received " + r[1] + "; chose " + r[2] + "; matches the priority: " + r[3], undefined, ul2); });
      e("p", recorded.note, "note");
    }
    if (trace && !$("m-obs").hidden) {
      var Ov = W.observe(W.validate(JSON.parse(JSON.stringify(M))).map, trace);
      e("h2", "Declared versus observed (one recorded execution)");
      e("p", "Trace source: " + (trace.source && trace.source.execution_id ? "execution " + trace.source.execution_id : "an imported trace") + ". " + Ov.caveat, "note");
      var ol2 = e("ul");
      Ov.rows.forEach(function (r) { e("li", W.agentLabel(M, r.agent) + ": " + (r.traced ? OBS[r.traced.observed].replace(/^\S+ /, "") + ". " + r.traced.why : "not in the trace"), undefined, ol2); });
      e("h2", "Discrepancies and gaps");
      var ul3 = e("ul");
      (Ov.discrepancies.length ? Ov.discrepancies.map(function (d) { return d.text; }) : ["None found within what was captured."]).forEach(function (t) { e("li", t, undefined, ul3); });
    }
    e("h2", "Next step");
    e("p", "Test whether the final decision changes with the priority: compare the deciding step with and without one line repeating the priority (the site's For developers page, or the priority_check package).");
    e("p", "This map describes the declared structure of the reader's own workflow. It is not a behavioural evaluation of it. priority_check chain runs a fixed six-handoff reference workflow, not these agents.", "note");
    // the fixed stylesheet is added as a string (it holds no visitor text); every visitor string went in via textContent
    var html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace("</head>", "<style>" + css + "</style></head>");
    download(fileSlug() + ".workflow-map-report.html", html, "text/html");
    $("m-err").textContent = "Saved a readable report as an .html file.";
  });
  $("t-export").addEventListener("click", function () {
    var r = W.chainScenario(M);
    if (!r.ok) { $("t-err").textContent = "Not saved yet: " + r.errors.join("; ") + "."; $("t-cmd").hidden = true; return; }
    var name = r.scenario.scenario_id + ".scenario.json";
    download(name, JSON.stringify(r.scenario, null, 1) + "\n", "application/json");
    $("t-err").textContent = "Saved " + name + ". The same file works with both commands below: `workflow` tests your own agents through an adapter; `chain` runs our fixed six-handoff reference workflow instead.";
    var runs = runsValue();
    if (!runs) { $("t-err").textContent = "Saved " + name + ", but the repetitions must be a whole number from 1 to 20 for the command."; $("t-cmd").hidden = true; return; }
    $("t-cmd-wf").textContent = "python3 -m priority_check workflow --scenario " + name + " --adapter my_adapter:MyAdapter --runs " + runs + " --orders both --out results_v1/";
    $("t-cmd-cmp").textContent = "python3 -m priority_check compare --baseline results_v1 --candidate results_v2";
    $("t-cmd-fake").textContent = "python3 -m priority_check chain --scenario " + name + " --provider fake --runs " + runs + " --out results_" + r.scenario.scenario_id.replace(/-/g, "_") + "/";
    $("t-cmd").hidden = false;
  });

  // repetitions: validated whole number 1..20; the call count is the kit's own formula (2 directions x 2 orders x 17 calls)
  function runsValue() { var v = $("t-runs").value.trim(); return /^[0-9]{1,2}$/.test(v) && +v >= 1 && +v <= 20 ? +v : 0; }
  function showCalls() {
    var n = runsValue();
    $("t-calls").textContent = n ? "Your own workflow (`workflow`): " + 14 * n + " executions of your workflow (" + n + " run(s) × 2 option orders × 7: with each priority, without a priority, and the direct and restated checks for each priority, if your adapter supports them); a real-model run needs --i-accept-costs and --max-executions " + 14 * n + ". " +
      "Reference chain (`chain`): " + 68 * n + " model calls (" + n + " run(s) × 2 priority directions × 2 option orders × 17); a real-model run needs --i-accept-costs and --max-calls " + 68 * n + ". With a fake model: no cost."
      : "Enter a whole number from 1 to 20.";
  }
  $("t-runs").addEventListener("input", showCalls);
  showCalls();

  // ------------------------------------------------------------ wiring
  function bindText(id, fn) { $(id).addEventListener("input", function () { fn($(id).value); draw(); }); }
  bindText("m-priority", function (v) { M.priority = v; });
  bindText("m-decision", function (v) { M.decision = v; });
  bindText("m-title", function (v) { M.title = v; });
  bindText("t-question", function (v) { M.test.question = v; });
  bindText("t-a", function (v) { M.test.option_a = v; });
  bindText("t-b", function (v) { M.test.option_b = v; });
  bindText("t-opp", function (v) { M.test.opposite_priority = v; });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="t-fav"]'), function (r) {
    r.addEventListener("change", function () { M.test.priority_favours = r.value; });
  });
  $("m-add").addEventListener("click", function () {
    if (M.agents.length >= W.MAX_AGENTS) return;
    M.agents.push(W.blankAgent(M.agents.length + 1)); renderAgents(); draw();
    var n = $("m-name-" + M.agents.length); if (n) n.focus();
  });
  $("m-example").addEventListener("click", loadExample);
  $("m-own").addEventListener("click", function () { load(W.blank(), null); $("m-err").textContent = "Started a new map."; $("m-priority").focus(); });
  form.addEventListener("submit", function (ev) { ev.preventDefault(); });
  $("test-form").addEventListener("submit", function (ev) { ev.preventDefault(); });
  // ------------------------------------------------------------ declared versus observed (a recorded execution trace)
  var OBS = { explicit: "● The priority's exact text is in its request", via_message: "◐ Possibly conveyed through an earlier agent's message",
    state_only: "◌ In state it could read; not in its request", none_observed: "○ No observed direct route", unknown: "? Unknown: not captured" };
  var DECL = { explicit: "● Given directly", via: "◐ Only through outputs or other context", none: "○ No declared route", unknown: "? Not specified" };
  var trace = null;
  function drawObserved() {
    if (!trace) { $("m-obs").hidden = true; return; }
    var v = W.validate(JSON.parse(JSON.stringify(M)));
    if (!v.ok) { $("m-obs").hidden = true; $("m-obs-err").textContent = "Complete the map first: " + v.errors.slice(0, 2).join("; ") + "."; return; }
    var O = W.observe(v.map, trace), A = W.analyse(v.map);
    var tb = $("m-obs-table").querySelector("tbody"); tb.replaceChildren();
    O.rows.forEach(function (r) {
      var tr = add(tb, h("tr")), th = add(tr, h("th", null, W.agentLabel(v.map, r.agent))); th.scope = "row";
      add(tr, h("td", null, DECL[A.agents[r.agent].exposure]));
      var td = add(tr, h("td"));
      if (!r.traced) { add(td, h("span", null, "Not in the trace")); return; }
      add(td, h("span", "wf-badge x-" + ({ explicit: "explicit", via_message: "via", state_only: "via", none_observed: "none", unknown: "unknown" })[r.traced.observed], OBS[r.traced.observed]));
      add(td, h("span", "r-cnote", r.traced.why + (r.traced.also ? " " + r.traced.also : "") + (r.traced.stateNote ? " " + r.traced.stateNote : "")));
    });
    O.traced.forEach(function (t) {
      if (O.rows.some(function (r) { return r.traced === t; })) return;
      var tr = add(tb, h("tr")), th = add(tr, h("th", null, t.id + " (not in your map)")); th.scope = "row";
      add(tr, h("td", null, "—")); add(tr, h("td", null, OBS[t.observed]));
    });
    var ul = $("m-obs-disc"); ul.replaceChildren();
    if (!O.discrepancies.length) add(ul, h("li", null, "No discrepancy found between your declared map and this recorded execution, within what was captured."));
    O.discrepancies.forEach(function (d) { var li = add(ul, h("li", null, d.text)); li.dataset.kind = d.kind; });
    $("m-obs-caveat").textContent = O.caveat + (O.incomplete.length ? " Not fully captured: " + O.incomplete.join(", ") + "." : "") +
      " Source: " + (trace.source && trace.source.execution_id ? "execution " + trace.source.execution_id : "an imported trace") + ".";
    $("m-obs").hidden = false;
  }
  function useTrace(x, label) {
    var v = W.validateTrace(x);
    if (!v.ok) { trace = null; $("m-obs").hidden = true; $("m-obs-err").textContent = "The trace was not opened: " + v.errors.slice(0, 4).join("; ") + "."; return; }
    trace = x; $("m-obs-err").textContent = "Opened " + label + " (" + x.agents.length + " traced agent records)" + (x.fake ? ". FAKE MODEL OUTPUT: not evidence about any model." : x.fake === false ? "." : "; whether its models were real or fake is not recorded in the file."); drawObserved();
  }
  var drawMap = draw;
  draw = function () { drawMap(); if (trace) drawObserved(); };   // edits to the declared map update the comparison
  $("m-trace").addEventListener("change", function () {
    var f = this.files && this.files[0]; this.value = "";
    if (!f) return;
    if (f.size > 5000000) { $("m-obs-err").textContent = "That file is too large to be a trace."; return; }
    var rd = new FileReader();
    rd.onload = function () {
      var x; try { x = JSON.parse(String(rd.result)); } catch (e) { $("m-obs-err").textContent = "That file is not valid JSON."; return; }
      useTrace(x, f.name);
    };
    rd.onerror = function () { $("m-obs-err").textContent = "The file could not be read."; };
    rd.readAsText(f);
  });
  $("m-obs-example").addEventListener("click", function () {
    var E = window.APA_EXAMPLE_WORKFLOW; if (!E) return;
    var v = W.validate(JSON.parse(JSON.stringify(E.declared)));
    load(v.map, null);
    useTrace(E.trace, "the example trace (LangGraph, fake model, one execution)");
    $("m-err").textContent = "Loaded the LangGraph example's declared map.";
    $("m-obs-h").scrollIntoView({ block: "start" });
  });

  // success and error messages share the alert region; style success distinctly (wording already differs)
  ["m-err", "t-err", "m-obs-err"].forEach(function (id) {
    var n = $(id);
    new MutationObserver(function () {
      var t = n.textContent;
      n.classList.toggle("r-ok", /^(Loaded |Opened |Saved |Started )/.test(t) && !/^Saved [^.]*, but /.test(t));
    }).observe(n, { childList: true, characterData: true, subtree: true });
  });
  window.__wfmapState = function () { return JSON.parse(JSON.stringify(M)); };   // read-only snapshot, for the browser tests
  load(W.blank(), null);
})();
