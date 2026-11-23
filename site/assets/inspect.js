// Inspect and compare page: entirely client-side. No network, no storage, no model. Files the visitor opens are read
// as bytes, parsed as JSON only (never executed) and rendered with textContent only. Loading, verification and the
// comparison rules are in runcompare.js (the same rules as `priority_check compare`); this file builds the view.
(function () {
  "use strict";
  var R = window.APARunCompare, S3 = window.STUDY3B;
  if (!R || !document.getElementById("r-out")) return;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function add(parent) { var last = parent; for (var i = 1; i < arguments.length; i++) if (arguments[i]) last = parent.appendChild(arguments[i]); return last; }
  function para(parent, text, cls) { return add(parent, h("p", cls, text)); }

  var COND_LABEL = {
    direct: "Direct: the deciding step gets the priority, no handoffs",
    delegated: "Delegated: the deciding step sees only the last handoff (the priority was given at the first handoff only)",
    restored: "Restored: the last handoff, plus the priority repeated at the deciding step",
    reanchored: "Re-anchored (study only): the priority inserted again at handoff 4; handoffs 4 to 6 regenerated",
    direct_no_priority: "Control, no priority: the deciding step gets neither",
    workflow: "Your whole workflow, the priority given where your system normally receives it",
    workflow_no_priority: "Control: your whole workflow without the priority (one run, scored against both priorities)",
    chain_no_priority: "Control, chain without priority: handoffs started without it"
  };
  var WF_LABEL = { direct: "Direct probe: your decision step alone, given the priority (no upstream reports)",
    restored: "Restored probe: your decision step on the same upstream input as the workflow run, plus the priority stated there" };
  var SHORT = { workflow: "Whole workflow", workflow_no_priority: "Workflow, no priority", direct: "Direct", delegated: "Delegated", restored: "Restored", reanchored: "Re-anchored", direct_no_priority: "No priority", chain_no_priority: "Chain without priority" };
  var MAX_FILE = 20 * 1024 * 1024;
  var PREV = "{{PREVIOUS_STAGE}}", HANDOFF = "{{T6_HANDOFF}}";   // study-data template slots (filled for display)
  var cur = null, later = null, lastCmp = null;

  // ------------------------------------------------------------ view model from a verified kit run
  function between(s, a, b) { var i = s.indexOf(a); if (i < 0) return null; i += a.length; var j = b ? s.indexOf(b, i) : s.length; return j < 0 ? null : s.slice(i, j); }
  function vmFromWorkflow(run, label) {
    var s = run.summary, recs = run.records || [], sc = s.scenario || {}, wf = s.workflow || {};
    var vm = { kind: !run.records_verified ? "unverified" : s.fake_run ? "fake" : "real", workflow: true, run: run, label: label || "",
      scenario: { task: sc.question ? sc.question + (sc.context ? "\n" + sc.context : "") : null, A: sc.option_a, B: sc.option_b, priority: { A: sc.priority_A, B: sc.priority_B } } };
    var ec = s.exposure_checks || {};
    vm.provenance = [
      ["Source", !run.records_verified ? "priority_check workflow summary (label unchecked: no records opened)" : "priority_check workflow: your system, run through its adapter" + (s.fake_run ? " with FAKE models" : "")],
      ["Workflow tested", (wf.name || "?") + " " + (wf.version || "") + ": " + "agents " + (wf.agents || []).map(function (a) { return a.id + " (" + a.role + ")"; }).join(", ") + " · fingerprint " + String(s.workflow_fingerprint || "").slice(0, 16) + "…"],
      ["Where the priority enters", wf.priority_entry || "?"],
      ["Models · provider", (wf.models || []).join(", ") + " · " + (wf.provider || "?") + "; served: " + ((s.models_served || []).join(", ") || "none")],
      ["Configuration passed", JSON.stringify(s.config || {})],
      ["Scenario", s.scenario_id + " (sha256 " + String(s.scenario_sha256).slice(0, 16) + "…)"],
      ["Repetitions", s.runs_requested + " run(s) per case × " + (s.orders_requested || []).length + " option order(s), one scenario; a fresh context was requested for every execution (the adapter's responsibility; checked only through the exposure checks below)"],
      ["Executions", s.executions + " of " + s.planned_executions + " planned" + (s.executions_failed ? " (" + s.executions_failed + " failed)" : "") + (s.incomplete ? " (INCOMPLETE: " + s.incomplete + ")" : "")],
      ["Not supported by this adapter", (s.not_supported || []).length ? s.not_supported.join(", ") + ": not tested" : "none"],
      ["Exposure checks (exact text)", "priority text in a no-priority execution: " + (ec.no_priority_executions_with_priority_text || 0) + "; opposite priority in a priority execution: " + (ec.priority_executions_with_opposite_priority_text || 0) +
        "; an earlier execution's output: " + (ec.executions_with_earlier_execution_output || 0) + "; executions without a trace: " + (ec.executions_without_trace || 0) + "; agent requests not fully captured: " + (ec.agent_requests_not_fully_captured || 0)],
      ["Given priority found, per agent", Object.keys(ec.workflow_priority_found_by_agent || {}).sort().map(function (k) { var v = ec.workflow_priority_found_by_agent[k]; return k + ": in its request " + v["model request"] + ", only in state " + v["visible state only"]; }).join("; ") || "nowhere (exact text; a paraphrase is not counted)"],
      ["Code fingerprint", s.code && s.code.sha256 ? String(s.code.sha256).slice(0, 16) + "… (" + s.code.files.join(", ") + "; " + s.code.note + ")" : "not recorded"],
      ["Reproduce", s.reproduce || "not recorded"],
      ["Records checked against the summary", run.records_verified ? "yes: sha256, counts, every answer re-read, scenario, no duplicated executions (not signed)" : "NO: only a summary was opened"],
      ["Run id · kit", (s.run_id || "?") + " · " + s.kit_version]];
    vm.conditions = (s.conditions || []).map(function (c) {
      var dirs = {};
      R.DIRECTIONS.forEach(function (d) {
        var choices = {};
        recs.forEach(function (x) { if (x.kind === "decision" && x.condition === c && x.direction === d) { var t = x.chosen_option_text || "(" + x.outcome.toLowerCase() + ")"; choices[t] = (choices[t] || 0) + 1; } });
        dirs[d] = { counts: s.counts[c] && s.counts[c][d] || null, choices: choices };
      });
      return { key: c, dirs: dirs };
    }).concat((s.not_supported || []).map(function (c) { return { key: c, dirs: { A: { counts: null, choices: {} }, B: { counts: null, choices: {} } }, note: "NOT SUPPORTED by this adapter: not tested." }; }));
    vm.paired = s.paired; vm.runs = s.runs_requested; vm.orders = (s.orders_requested || []).length;
    vm.cases = recs.filter(function (x) { return x.kind === "execution"; }).map(function (x) {
      var agents = (x.trace && x.trace.agents) || [];
      return { label: "Run " + (x.run + 1) + " · options " + (x.order === "as_given" ? "as given" : "swapped") + " · " + (SHORT[x.condition] || x.condition) + (x.direction ? " · priority favours " + x.direction : ""),
        execution: x,
        arms: { with_priority: agents.map(function (a, i) {
          return { n: i + 1, title: "Agent " + a.id + " · " + (a.role || "") + (a.model ? " · " + a.model : ""), prompt: (a.request_messages || null) && a.request_messages.map(function (m) { return "[" + m.role + "] " + m.content; }).join("\n\n"),
            capture: a.request_messages ? (a.request_complete ? "full" : "partial") : "none", state: a.state_visible, text: a.output, error: a.error };
        }), no_priority: null },
        decisions: recs.filter(function (y) { return y.kind === "decision" && y.execution_id === x.execution_id; }).map(function (y) {
          return { condition: y.condition, prompt: null, text: y.response_text, outcome: y.outcome + (y.shared_execution ? " (vs priority " + y.direction + ")" : ""), choice: y.chosen_option_text, error: y.error };
        }) };
    });
    return vm;
  }

  function vmFromRun(run, label) {
    if (run.summary.summary_format === R.WF_FORMAT) return vmFromWorkflow(run, label);
    var s = run.summary, recs = run.records || [];
    var vm = { kind: !run.records_verified ? "unverified" : s.fake_run ? "fake" : "real", run: run, label: label || "", scenario: { task: null, A: null, B: null, priority: { A: null, B: null } } };
    recs.forEach(function (x) {
      if (x.kind === "handoff" && x.handoff === 1 && x.chain_arm === "with_priority" && typeof x.prompt === "string") {
        if (!vm.scenario.priority[x.direction]) vm.scenario.priority[x.direction] = between(x.prompt, "What they have told you matters to them:\n", "\n\nTheir situation:");
        if (!vm.scenario.task) vm.scenario.task = between(x.prompt, "TASK: ", "\nOPTION A: ");
      }
      if (x.direction === "A" && x.target_option_text) vm.scenario.A = x.target_option_text;
      if (x.direction === "B" && x.target_option_text) vm.scenario.B = x.target_option_text;
    });
    vm.provenance = [
      ["Source", !run.records_verified ? "priority_check chain summary, labelled " + (s.fake_run ? "fake" : "real") + " (label unchecked: no records opened)" :
        s.fake_run ? "priority_check chain, built-in FAKE model" : "priority_check chain, real provider"],
      ["Workflow tested", "the kit's fixed six-handoff reference workflow (not your own agents)"],
      ["Provider · model requested · served", s.provider + " · " + s.model_requested + " · " + ((s.models_served || []).join(", ") || "none")],
      ["Settings", JSON.stringify(s.settings)],
      ["Scenario", s.scenario_id + " (sha256 " + String(s.scenario_sha256).slice(0, 16) + "…)"],
      ["Repetitions", s.runs_requested + " run(s) per case × " + (s.orders_requested || []).length + " option order(s), one scenario"],
      ["Calls recorded", s.calls_recorded + " of " + s.planned_calls + " planned" + (s.incomplete ? " (INCOMPLETE: " + s.incomplete + ")" : "")],
      ["Records checked against the summary", run.records_verified ? "yes: sha256, counts, provider and model, every answer re-read, scenario text, no duplicated calls (the files are not signed, so this catches edits, not every forgery)" : "NO: only a summary was opened"],
      ["Run id · kit", (s.run_id || "?") + " · " + s.kit_version]];
    vm.conditions = R.CONDITIONS.map(function (c) {
      var dirs = {};
      R.DIRECTIONS.forEach(function (d) {
        var k = s.counts[c] && s.counts[c][d];
        var choices = {};
        recs.forEach(function (x) { if (x.kind === "decision" && x.condition === c && x.direction === d) { var t = x.chosen_option_text || "(" + x.outcome.toLowerCase() + ")"; choices[t] = (choices[t] || 0) + 1; } });
        dirs[d] = { counts: k || null, choices: choices };
      });
      return { key: c, dirs: dirs };
    });
    vm.paired = s.paired;
    vm.runs = s.runs_requested; vm.orders = (s.orders_requested || []).length;
    vm.cases = [];
    var byCase = {};
    recs.forEach(function (x) {
      var id = x.run + "|" + x.order + "|" + x.direction;
      var c = byCase[id];
      if (!c) { c = byCase[id] = { label: "Run " + (x.run + 1) + " · options " + (x.order === "as_given" ? "as given" : "swapped") + " · priority favours " + x.direction, arms: { with_priority: [], no_priority: [] }, decisions: [] }; vm.cases.push(c); }
      if (x.kind === "handoff") c.arms[x.chain_arm].push({ n: x.handoff, role: x.role, prompt: x.prompt, text: x.response_text, error: x.error });
      else c.decisions.push({ condition: x.condition, prompt: x.prompt, text: x.response_text, outcome: x.outcome, choice: x.chosen_option_text, error: x.error });
    });
    return vm;
  }

  // ------------------------------------------------------------ view model from recorded Study 3B data (one scenario, both orders, both priorities)
  function studyScenario() { return S3.cases.filter(function (c) { return c.id === S3.selection.opening_case; })[0].scenario; }
  function loadStudy(done) {
    var sc = studyScenario(), cases = S3.cases.filter(function (c) { return c.scenario === sc; }), texts = {}, i = 0;
    function next() {
      if (i >= cases.length) return done(vmFromStudy(sc, cases, texts));
      var id = cases[i].id;
      window.__s3bText = function (t) { texts[id] = t; i++; next(); };
      var el = document.createElement("script"); el.src = "assets/s3b/" + encodeURIComponent(id) + ".js";
      el.onerror = function () { $("r-err").textContent = "The recorded study texts could not be loaded."; };
      document.head.appendChild(el);
    }
    next();
  }
  function vmFromStudy(sc, cases, texts) {
    var orig = cases.filter(function (c) { return c.order === "orig"; })[0];
    var A = orig.options.A, B = orig.options.B;
    function dirOf(c) { return c.options[c.target] === A ? "A" : "B"; }
    var vm = { kind: "study", run: null, label: "", scenario: { task: orig.task, A: A, B: B, priority: { A: null, B: null } } };
    cases.forEach(function (c) { vm.scenario.priority[dirOf(c)] = c.priority; });
    vm.provenance = [
      ["Source", "Recorded study data: the Study 3B development pilot (" + S3.status + ")"],
      ["Workflow tested", "the study's six-handoff workflow (the same structure the kit's reference workflow uses)"],
      ["Model", S3.model + " (one model)"],
      ["Scenario", orig.title + " · " + orig.pair_label + " (" + sc + "), one of " + S3.n_scenarios + " scenarios"],
      ["Repetitions", "1 run per case × 2 option orders, one scenario"],
      ["Provenance", "plan sha256 " + S3.provenance.plan_sha256.slice(0, 16) + "…, ledger head " + S3.provenance.ledger_head_sha256.slice(0, 16) + "…; an independent recomputation of the recorded choices found 0 case-level disagreements (140 row-wise comparisons, not 140 separate calls)"]];
    var CONDS = ["direct", "delegated", "restored", "reanchored", "direct_no_priority", "chain_no_priority"];
    vm.conditions = CONDS.map(function (key) {
      var dirs = {};
      ["A", "B"].forEach(function (d) {
        var cs = cases.filter(function (c) { return dirOf(c) === d; });
        var counts = { MATCHED: 0, OPPOSITE: 0, UNCLEAR: 0, INVALID: 0, MISSING: 0 }, choices = {}, n = 0;
        cs.forEach(function (c) {
          var ch = key === "direct_no_priority" ? c.no_priority_choice : c.choices[key];
          if (key === "chain_no_priority" || ch === undefined) return;
          n++;
          if (ch === "ABSTAIN") { counts.UNCLEAR++; choices["(declined to choose)"] = (choices["(declined to choose)"] || 0) + 1; return; }
          var text = c.options[ch];
          counts[text === c.options[c.target] ? "MATCHED" : "OPPOSITE"]++;
          choices[text] = (choices[text] || 0) + 1;
        });
        dirs[d] = { counts: n ? counts : null, choices: choices };
      });
      var note = key === "chain_no_priority" ? "Not measured in this study." :
        key === "direct_no_priority" ? "One recorded call per option order, shared by both priorities (the prompt has no priority), so each call appears under both." :
        key === "reanchored" ? "A study-only condition; the kit does not run it." : "";
      return { key: key, dirs: dirs, note: note };
    });
    vm.paired = null;
    vm.runs = 1; vm.orders = 2;
    vm.cases = cases.map(function (c) {
      var t = texts[c.id];
      var roles = ["advisor", "critic", "summarizer", "advisor", "critic", "summarizer"];
      var dec = ["direct", "delegated", "restored", "reanchored"].map(function (k) {
        var ch = c.choices[k];
        var tpl = t.decisions[k] && t.decisions[k].prompt, h6 = k === "reanchored" ? (t.reanchor || [])[(t.reanchor || []).length - 1] : t.chain[5];
        var asm = typeof tpl === "string" && tpl.indexOf(HANDOFF) >= 0 && typeof h6 === "string";
        return { condition: k, prompt: asm ? tpl.split(HANDOFF).join(h6) : tpl, assembled: asm ? (k === "reanchored" ? "the recorded new handoff 6" : "the recorded handoff 6") : null, text: t.decisions[k] && t.decisions[k].text,
          outcome: (c.outcomes[k] || "").toUpperCase() || null, choice: ch === "ABSTAIN" ? null : c.options[ch] };
      });
      return { label: "Options " + (c.order === "orig" ? "as given" : "swapped") + " · priority favours " + dirOf(c) + " · recorded case " + c.id,
        arms: { with_priority: t.chain.map(function (x, i) {
          var tpl = t.chain_prompts[i], asm = i > 0 && typeof tpl === "string" && tpl.indexOf(PREV) >= 0;
          return { n: i + 1, role: roles[i], prompt: asm ? tpl.split(PREV).join(t.chain[i - 1]) : tpl, assembled: asm ? "the recorded handoff " + i : null, text: x }; }), no_priority: null },
        decisions: dec };
    });
    return vm;
  }

  // ------------------------------------------------------------ rendering
  function kindBanner(vm) {
    var box = h("div", "r-kind r-kind-" + vm.kind);
    var t = { fake: ["FAKE MODEL OUTPUT: NOT EVIDENCE", vm.workflow ? "Your adapter reports fake (offline) models for this run. It shows how your workflow and this page work. Its numbers say nothing about any real model." :
        "This run used the kit's built-in deterministic fake model. It shows how the workflow and this page work. Its numbers say nothing about any real model."],
      real: vm.workflow ? ["Real model run, your workflow", "Recorded executions of your own workflow through its adapter, with the models named below. The records are checked for consistency; they are not signed."] :
        ["Real model run, reference workflow", "Recorded calls to the model named below, through the kit's fixed six-handoff reference workflow, not your own agents. The records are checked for consistency; they are not signed."],
      unverified: ["UNVERIFIED SUMMARY: NOT EVIDENCE", "Only a summary.json was opened. Its provider, model, fake or real label and counts can't be checked without its records.jsonl, so treat nothing here as evidence. Open both files from the run folder."],
      study: ["Recorded study data", "Real recorded calls from the Study 3B development pilot, shown unchanged with their provenance. One model, constructed scenarios, descriptive only."] }[vm.kind];
    add(box, h("b", null, t[0])); add(box, h("span", null, t[1]));
    return box;
  }
  function outcomeText(k) {
    if (!k) return "not measured";
    var n = 0; R.OUTCOMES.forEach(function (o) { n += k[o]; });
    if (!n) return "not measured";
    if (k.MISSING === n) return "no usable decision: all " + n + " call(s) failed";
    return R.OUTCOMES.filter(function (o) { return k[o]; }).map(function (o) { return o + " " + k[o]; }).join(" · ") + " (of " + n + ")";
  }
  function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // 2026-11-23 (agent usability tests): the main finding first, in five plain answers; details follow below
  function renderVerdict(vm) {
    var box = $("r-verdict"); box.replaceChildren();
    add(box, h("h3", null, "The finding"));
    var s = vm.run ? vm.run.summary : {}, ec = s.exposure_checks || {}, wf = s.workflow || {}, P = vm.paired || {};
    var dl = add(box, h("dl", "r-vlist"));
    function row(k, v) { add(dl, h("dt", null, k)); add(dl, h("dd", null, v)); }
    var main = vm.workflow ? "workflow" : "delegated";
    var task = vm.scenario && vm.scenario.task ? "\u201c" + trunc(vm.scenario.task, 110) + "\u201d" : "one scenario";
    row("What was tested", (vm.workflow ? "Your workflow (" + (wf.name || "?") + ": " + (wf.agents || []).map(function (a) { return a.id; }).join(" → ") + ")" :
      vm.kind === "study" ? "Recorded study data: the six-handoff workflow of the earlier pilot" : "Our fixed six-handoff reference workflow, not your own agents") +
      " on " + task + ", with each of two opposite priorities" + (vm.runs ? ", " + vm.runs + " run(s) × " + vm.orders + " option order(s)" : "") + "." + (vm.kind === "fake" ? " FAKE model: not evidence about any model." : ""));
    var bad = [];
    if (vm.kind === "unverified") bad.push("only a summary was opened, so nothing could be checked");
    if (s.incomplete) bad.push("the run is incomplete");
    if (ec.no_priority_executions_with_priority_text) bad.push(ec.no_priority_executions_with_priority_text + " no-priority execution(s) contained a priority");
    if (ec.priority_executions_with_opposite_priority_text) bad.push(ec.priority_executions_with_opposite_priority_text + " execution(s) contained the opposite priority");
    if (ec.executions_with_earlier_execution_output) bad.push(ec.executions_with_earlier_execution_output + " execution(s) contained an earlier execution's output");
    var recsAll = (vm.run && vm.run.records) || [];
    var where = recsAll.filter(function (x) { var e = x.kind === "execution" && x.exposure; return e && ((e.earlier_execution_output_found || []).length || (e.priority_text_in_no_priority_execution || []).length || (e.opposite_priority_found || []).length); })
      .slice(0, 3).map(function (x) {
        var e = x.exposure, ag = [].concat(e.earlier_execution_output_found || [], e.priority_text_in_no_priority_execution || [], e.opposite_priority_found || []).map(function (f) { return f.agent; });
        return "run " + (x.run + 1) + ", options " + (x.order === "as_given" ? "as given" : "swapped") + ", " + (SHORT[x.condition] || x.condition) + (x.direction ? " " + x.direction : "") + ": agent " + ag.filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ");
      });
    var np = recsAll.filter(function (x) { return x.kind === "decision" && x.condition === "workflow_no_priority" && x.direction === "A" && x.chosen_option_text; });
    var npSame = np.length >= 2 && np.every(function (x) { return x.chosen_option_text === np[0].chosen_option_text; });
    row("Is it a valid controlled comparison?", (bad.length ? "No: " + bad.join("; ") + (where.length ? " (e.g. " + where.join("; ") + ")" : "") + ". Fix this before reading the result; see each agent's input below." :
      vm.workflow ? (ec.executions_with_trace ? "No contamination detected by the exact-text checks: records verified; no priority text in the no-priority control; no novel earlier output carried between executions. Not checked: paraphrases, carried option text, carryover shorter than a sentence, a cache that replays an agent's own earlier output, memory that is unrecorded or carries text identical to this execution's own later output, and anything your instrumentation does not record." : "Partly: records verified, but your adapter returned no traces, so independence could not be checked.") :
      "Records verified against the summary.") +
      (ec.executions_with_unrecorded_source_suspected ? " Advisory (does not invalidate): in " + ec.executions_with_unrecorded_source_suspected + " execution(s) an agent's output contained another agent's sentence from an earlier execution that its recorded input lacks (" +
        recsAll.filter(function (x) { return x.kind === "execution" && x.exposure && (x.exposure.unrecorded_source_suspected || []).length; }).slice(0, 3).map(function (x) {
          return "run " + (x.run + 1) + ", " + (SHORT[x.condition] || x.condition) + (x.direction ? " " + x.direction : "") + ": agent " + x.exposure.unrecorded_source_suspected.map(function (f) { return f.agent; }).join(", "); }).join("; ") +
        "). That can be an unrecorded memory, cache or session history, or legitimately shared text: check those agents before relying on the comparison." : "") +
      (ec.executions_with_trace_out_of_order ? " In " + ec.executions_with_trace_out_of_order + " execution(s) the trace did not list agents in execution order, so the carryover check did not rely on order there." : "") +
      (vm.workflow && npSame ? " Note: without a priority the workflow chose the same option (\u201c" + trunc(np[0].chosen_option_text, 60) + "\u201d) in every execution. That can be its genuine default, or something (for example a remembered earlier choice) reaching the control; the text checks can't tell which, so it is not counted as contamination." : ""));
    function pr(k) { var p = P[k]; return p ? p.both_priorities_got_their_own_option + " of " + p.readable_cases : null; }
    var resp = [];
    if (pr(main)) resp.push((vm.workflow ? "through your workflow" : "after six handoffs") + ": " + pr(main) + " pair(s)");
    if (pr("direct")) resp.push("decision step told the priority directly: " + pr("direct"));
    if (pr("restored")) resp.push("same input with the priority restated: " + pr("restored"));
    row("Did the decision respond to opposite priorities?", resp.length ? "Each of two opposite priorities got its own option " + resp.join("; ") + "." +
      " (A pair passes only if both opposite priorities got their own option.)" : "Not measured in this result.");
    var flow;
    if (vm.workflow) {
      var by = ec.workflow_priority_found_by_agent || {}, ids = (wf.agents || []).map(function (a) { return a.id; }), last = ids[ids.length - 1];
      var got = ids.filter(function (i) { return by[i] && by[i]["model request"]; });
      var tids = {}; ((vm.run && vm.run.records) || []).forEach(function (x) { if (x.kind === "execution" && x.trace && Array.isArray(x.trace.agents)) x.trace.agents.forEach(function (ag) { if (ag && ag.id !== undefined) tids[ag.id] = 1; }); });
      var stray = Object.keys(tids).filter(function (i) { return ids.indexOf(i) < 0; });
      flow = stray.length ? "Not reliable: the trace's agent ids (" + stray.slice(0, 3).join(", ") + (stray.length > 3 ? ", …" : "") + ") are not the agents your adapter declares (" + ids.join(", ") + "). Give every traced agent the same id it has in describe(), in every execution, then run again." :
        !ec.executions_with_trace ? "Not observable: no traces were returned." :
        "The priority's exact text reached the model request of: " + (got.length ? got.join(", ") : "no agent") + "." +
        (last && got.indexOf(last) < 0 ? (P[main] && P[main].readable_cases && P[main].both_priorities_got_their_own_option === P[main].readable_cases ?
          " Its exact text never reached the decision step (" + last + "), yet the decision followed both opposite priorities, so the priority reached it in other words." :
          " It never reached the decision step (" + last + ") verbatim; it may have arrived paraphrased or not at all. See what each agent received below.") :
          " Whether each of these routes was intended is checked on the Workflow Map: save one execution's trace below and open it next to your declared map.");
    } else flow = "Read each recorded handoff below to see where the priority's wording changed.";
    row("What information-flow issue was found?", flow);
    var next, pm = P[main], pd = P.direct;
    if (bad.length) next = "Make every execution start from a fresh context (and keep the no-priority control free of the priority), run again, then read the result.";
    else if (pm && pd && pm.both_priorities_got_their_own_option < pd.both_priorities_got_their_own_option)
      next = "The decision step follows the priority when given it directly, but less often through " + (vm.workflow ? "your workflow" : "the handoffs") + ". Try passing the priority (or a faithful summary of it) to the decision step, run again, and compare the two runs below.";
    else if (pm && pm.both_priorities_got_their_own_option === pm.readable_cases && pm.readable_cases)
      next = "The decision followed both opposite priorities here. Keep this as a regression check, and repeat with more scenarios and your real model before relying on it.";
    else next = "Look at what each agent received (below) to find where the priority stops, change that step, run again, and compare.";
    row("What can I do next?", next);
    add(box, h("p", "fine", "One scenario; a difference is a reason to investigate, not proof. Full counts, caveats and provenance are below."));
    try { box.scrollIntoView({ block: "start" }); } catch (e) { /* older browsers */ }
  }
  function render(vm) {
    cur = vm; later = null; lastCmp = null;
    $("c-example").hidden = !(vm.run && vm.run.source === "example (fake)");
    $("c-wf-example").hidden = !(vm.run && vm.run.source === "example workflow (fake, as shipped)");
    $("r-out").hidden = false; $("c-sec").hidden = false; $("c-out").hidden = true; $("c-err").textContent = "";
    $("r-kind").replaceChildren(kindBanner(vm));
    var dl = $("r-prov"); dl.replaceChildren();
    vm.provenance.forEach(function (p) { add(dl, h("dt", null, p[0])); add(dl, h("dd", null, p[1])); });
    renderVerdict(vm);
    var sc = vm.scenario;

    var q1 = $("q1"); q1.replaceChildren();
    if (!sc.priority.A && !sc.priority.B) para(q1, "Not available: only a summary was opened. Open records.jsonl too to see the texts.");
    else {
      para(q1, vm.kind === "study" ? "In this recorded study the researchers set two opposing priorities, so that each option has a priority favouring it. You did not specify these." :
        "The test uses your priority and its opposite, so that each option has a priority favouring it. One of these is the priority you specified; the other is its opposite. If you saved the scenario from the Workflow Map, yours is the one favouring the option you picked there.", "small");
      ["A", "B"].forEach(function (d) {
        var b = add(q1, h("div", "r-pri"));
        add(b, h("b", null, "Priority favouring option " + d));
        add(b, h("p", "r-quote", sc.priority[d] || "(not recorded)"));
        add(b, h("p", "small", "Option " + d + ": " + (sc[d] || "?")));
      });
      if (sc.task) para(q1, "Decision: " + sc.task, "small");
    }

    var q2 = $("q2"); q2.replaceChildren();
    var del = vm.conditions.filter(function (c) { return c.key === (vm.workflow ? "workflow" : "delegated"); })[0];
    para(q2, vm.workflow ? "Your workflow's own decision: the whole workflow run with the priority given where your system normally receives it." :
      (vm.kind === "study" ? "In the study's six-handoff workflow" : "In the kit's reference workflow (not your own system)") + ", the workflow's own decision is the Delegated one: the deciding step sees only what the six handoffs passed on.");
    var ul = add(q2, h("ul"));
    ["A", "B"].forEach(function (d) {
      var ch = del.dirs[d].choices, keys = Object.keys(ch);
      add(ul, h("li", null, "When the priority favoured option " + d + ": " + (keys.length ? keys.map(function (k) { return "chose \"" + trunc(k, 90) + "\" × " + ch[k]; }).join("; ") : outcomeText(del.dirs[d].counts))));
    });

    var q3 = $("q3"); q3.replaceChildren();
    para(q3, "Each cell counts the deciding step's answers. MATCHED = chose the option that priority favours; OPPOSITE = chose the other; UNCLEAR = declined; INVALID = no answer in the required form; MISSING = the call failed or wasn't made. They are never merged. For the controls, MATCHED only means the choice happened to coincide.", "small");
    var tw = add(q3, h("div", "r-tablewrap")), tb = add(tw, h("table", "r-table"));
    var hr = add(add(tb, h("thead")), h("tr"));
    add(hr, h("th", null, "Condition")); add(hr, h("th", null, "Priority favours A")); add(hr, h("th", null, "Priority favours B"));
    if (vm.paired) add(hr, h("th", null, "Both priorities got their own option"));
    var body = add(tb, h("tbody"));
    vm.conditions.forEach(function (c) {
      var tr = add(body, h("tr")); var th = add(tr, h("th", null, (vm.workflow && WF_LABEL[c.key]) || COND_LABEL[c.key])); th.scope = "row";
      if (c.note) add(th, h("span", "r-cnote", c.note));
      ["A", "B"].forEach(function (d) { add(tr, h("td", c.dirs[d].counts ? null : "r-nm", outcomeText(c.dirs[d].counts))); });
      if (vm.paired && c.key === "workflow_no_priority") { add(tr, h("td", "r-nm", "not applicable: one shared execution per case")); return; }
      if (vm.paired) { var p = vm.paired[c.key]; add(tr, h("td", null, p ? p.both_priorities_got_their_own_option + " of " + p.readable_cases + " readable pair(s)" : "not measured")); }
    });
    var reps = add(q3, h("p", "r-reps"));
    reps.textContent = "Repetitions: " + vm.runs + " run(s) per case × " + vm.orders + " option order(s) = " + vm.runs * vm.orders + " decision(s) per cell, all from ONE scenario. These are repeated samples of the same scenario, not independent scenarios.";
    var ec = vm.run && vm.run.summary.exposure_checks;
    if (ec && (ec.no_priority_executions_with_priority_text || ec.priority_executions_with_opposite_priority_text || ec.executions_with_earlier_execution_output))
      add(q3, h("p", "r-warn", "Contaminated: text was found where it should not be (" + ec.no_priority_executions_with_priority_text + " no-priority execution(s) contained a priority; " +
        ec.priority_executions_with_opposite_priority_text + " priority execution(s) contained the opposite one; " + (ec.executions_with_earlier_execution_output || 0) + " contained an earlier execution's output). Executions were not independent or the control was contaminated, so these counts can't be read as a controlled comparison. Check that each execution starts from a fresh context."));
    if (ec && ec.executions_with_earlier_execution_output && vm.run && (vm.run.records || []).some(function (x) { return x.kind === "execution" && x.exposure_checked && x.exposure_rule === undefined; }))
      add(q3, h("p", "r-warn", "This run was checked with the earlier carryover rule (before 23 November 2026). That rule could flag text a workflow legitimately repeats, for example a template or task text that every execution produces, as an earlier execution's output. The stored result is shown as recorded. Re-run the workflow with the current priority_check, whose corrected check distinguishes repeated template text from a genuinely reused earlier output, before treating this as contamination."));
    if (vm.runs > 1) {
      var one = 0, cells = 0;
      vm.conditions.forEach(function (c) { ["A", "B"].forEach(function (d) { var k = c.dirs[d].counts; if (!k) return; var t = 0, mx = 0; R.OUTCOMES.forEach(function (o) { t += k[o]; if (k[o] > mx) mx = k[o]; }); if (t) { cells++; if (mx === t) one++; } }); });
      add(q3, h("p", "r-reps", "Consistency: in " + one + " of " + cells + " measured cells, every decision gave the same outcome (repetitions and both option orders pooled; a difference between the orders is a position effect, not run-to-run variation)." + (vm.kind === "fake" ? " (The fake model is deterministic, so this says nothing about real run-to-run variation.)" : "")));
    }
    if (vm.runs === 1) add(q3, h("p", "r-warn", "With one run per case, the same prompt can give a different answer when called again. A single answer is not evidence of a stable behaviour. Repeat the run (--runs 3 or more) to see how consistent it is."));
    para(q3, "BLOCKED is not a separate category in these records: a blocked, refused or truncated response is recorded as a failed call (MISSING), and a free-text refusal without the required first line is INVALID.", "small");

    renderHandoffs(vm);

    var q5 = $("q5"); q5.replaceChildren();
    var tips = add(q5, h("ul"));
    var dir = vm.conditions.filter(function (c) { return c.key === "direct"; })[0];
    function matched(c) { var m = 0; if (!c) return 0; ["A", "B"].forEach(function (d) { if (c.dirs[d].counts) m += c.dirs[d].counts.MATCHED; }); return m; }
    if (vm.workflow) {
      if (vm.runs === 1) add(tips, h("li", null, "First, repeat the same configuration (--runs 3 or more) and compare it with this one. Until then you can't tell a stable pattern from run-to-run variation."));
      add(tips, h("li", null, "Read the traces (question 4) and save one execution's trace for the Workflow Map: it shows where the priority's exact words appeared in each agent's recorded request or state, and routes you didn't declare. It can't show a paraphrase."));
      add(tips, h("li", null, "Change one thing in your system (a prompt, a model, what a handoff passes on), pass it as --config or change the adapter, run priority_check workflow again with the same scenario, and compare the two runs below. Every recorded difference will be listed."));
      if ((vm.run.summary.not_supported || []).length) add(tips, h("li", null, "Not tested here: " + vm.run.summary.not_supported.join(", ") + ". To measure them, expose your decision step through the adapter (decide_direct, decide_restored)."));
    } else {
    if (vm.runs === 1) add(tips, h("li", null, "First, repeat the same configuration (for example --runs 3) and compare it with this one. Until then you can't tell a stable pattern from run-to-run variation."));
    if (matched(del) < matched(dir) && vm.kind !== "fake" && vm.kind !== "unverified") add(tips, h("li", null, "Here the Delegated decisions matched the priority less often than the Direct ones. One change to test is giving the priority to the deciding step itself. The Restored row is that change, measured in the same run, for this reference workflow."));
    add(tips, h("li", null, "Change one thing (the model, a setting, or your scenario's wording), run priority_check chain again with the same scenario, then compare the two runs below. Every difference between the runs will be listed, not only the one you meant to change."));
    add(tips, h("li", null, "To test your own system's deciding step rather than the reference workflow, use priority_check run with your own adapter (see For developers). Your Workflow Map shows where in your system the priority is given."));
    }
    var cmdp = add(q5, h("p", "small"));
    cmdp.textContent = vm.workflow ? "Each run makes " + (vm.run.summary.planned_executions / Math.max(1, vm.runs)) + " adapter executions per repetition (workflow A, B and no priority per option order, plus any supported probes); your workflow's own model calls per execution add up from there. A real model bills every call; the kit refuses real adapters without --i-accept-costs and --max-executions equal to the planned count." :
      "Calls per run of chain: 68 × runs with both option orders (2 directions × 2 orders × 17 calls), for example 204 calls for --runs 3. The fake model costs nothing. A real model bills every call to your own key, and the kit refuses to start without --i-accept-costs and --max-calls equal to that count.";

    var ev = $("r-evidence"); ev.replaceChildren();
    var yes = add(ev, h("div", "r-yes")), no = add(ev, h("div", "r-no"));
    add(yes, h("b", null, "It establishes"));
    var y = add(yes, h("ul"));
    if (vm.kind === "fake") add(y, h("li", null, "That the workflow ran end to end and how the records look. Nothing about any model: the answers come from a fake."));
    else if (vm.kind === "unverified") add(y, h("li", null, "Nothing yet: the records were not opened, so even the model label is unchecked."));
    else {
      add(y, h("li", null, "What this " + (vm.kind === "study" ? "model" : "model configuration") + " chose on this one scenario, in these " + vm.runs * vm.orders + " decision(s) per cell, recorded with provenance."));
      add(y, h("li", null, vm.workflow ? "Whether, in these recorded executions, your workflow's final decision followed the priority it was given, compared with the opposite priority and with none." :
        "Whether, in these recorded calls, the decision followed the priority when the deciding step was given it (Direct and Restored), and when it saw only the handoffs (Delegated)."));
    }
    add(no, h("b", null, "It does not establish"));
    var n2 = add(no, h("ul"));
    [vm.workflow ? "How your system behaves outside this test: it ran as the adapter ran it, on one scenario, with these models and this configuration." :
      "How your own agents behave: this tested " + (vm.kind === "study" ? "the study's" : "the kit's") + " six-handoff workflow, not your system.",
      "Anything about other decisions: this is one scenario.",
      vm.runs === 1 ? "Stability: one run per case cannot separate a pattern from run-to-run variation." : "That a difference between conditions is statistically reliable: no statistical test is run.",
      "Why a decision changed: the handoffs can be read, but reading them is not a causal test."].forEach(function (t) { add(n2, h("li", null, t)); });

    $("r-save").disabled = !vm.run || !vm.run.records_verified;
    $("r-save-note").textContent = vm.run ? (vm.run.records_verified ? "The saved .json holds the run's summary and records unchanged. Open it here later, or pass it to priority_check compare, and the records are checked again." :
      "Saving needs the records file too: open summary.json together with records.jsonl.") : "Recorded study data is already part of this site; save a readable report instead.";
  }

  function renderHandoffs(vm) {
    var q4 = $("q4"); q4.replaceChildren();
    if (!vm.cases.length) { para(q4, "Not available: only a summary was opened. Open records.jsonl too to read the handoffs."); return; }
    para(q4, "Read exactly what each step received and passed on. This is inspection: it shows what was said, not why the decision changed.", "small");
    var lab = add(q4, h("label", "r-sel", "Case "));
    lab.setAttribute("for", "r-case");
    var sel = add(q4, h("select")); sel.id = "r-case";
    vm.cases.forEach(function (c, i) { var o = add(sel, h("option", null, c.label)); o.value = String(i); });
    var arms = add(q4, h("fieldset", "wf-q")); add(arms, h("legend", null, "Which chain"));
    if (vm.workflow) arms.hidden = true;
    var hasNo = vm.cases[0].arms.no_priority && vm.cases[0].arms.no_priority.length;
    [["with_priority", "Started with the priority"], ["no_priority", "Started without it (control)"]].forEach(function (a, i) {
      if (i === 1 && !hasNo) return;
      var l = add(arms, h("label")), r = h("input"); r.type = "radio"; r.name = "r-arm"; r.value = a[0]; if (!i) r.checked = true;
      add(l, r); add(l, document.createTextNode(" " + a[1]));
      r.addEventListener("change", draw);
    });
    if (!hasNo && !vm.workflow) para(q4, "The control chain without the priority is not in this record.", "small");
    if (vm.workflow) {
      para(q4, "Each case is one execution of your workflow. For every agent the trace shows the model request it actually received (if your instrumentation captured it), the framework state it could read, and its output.", "small");
      var tb = add(q4, h("div", "no-print wf-actions")), tbtn = add(tb, h("button", "btn ghost", "Save this execution's trace (.json), for the Workflow Map"));
      tbtn.type = "button"; tbtn.id = "r-trace-save";
      tbtn.addEventListener("click", function () {
        var x = vm.cases[+sel.value].execution, rq = x.request || {};
        var sc = vm.run.summary.scenario || {};
        var t = { format: "apa-trace/1", priority: rq.priority || "", task: rq.task, option_a: rq.option_a, option_b: rq.option_b,
          fake: !!vm.run.summary.fake_run, control_priorities: rq.priority ? [] : [sc.priority_A, sc.priority_B],
          opposite_priority: rq.priority ? (x.direction === "A" ? sc.priority_B : x.direction === "B" ? sc.priority_A : "") || "" : "",
          source: { run_id: x.run_id, execution_id: x.execution_id, condition: x.condition, direction: x.direction, order: x.order, run: x.run },
          agents: (x.trace && x.trace.agents) || [] };
        download((x.execution_id || "execution").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80) + ".trace.json", JSON.stringify(t, null, 1) + "\n", "application/json");
        status("r-err", "Saved this execution's trace. Open it on the Workflow Map under \"Declared versus observed\"" + (t.priority ? (x.condition === "workflow" ? "." : "; it is a " + x.condition + " probe, so it shows the probe, not your routing.") : "; it is a no-priority execution, so the map checks it for leaked priority text."));
      });
    }
    var box = add(q4, h("div", "r-chain")); box.id = "r-chain";
    sel.addEventListener("change", draw);
    function draw() {
      var c = vm.cases[+sel.value], armEl = q4.querySelector('input[name="r-arm"]:checked'), arm = armEl ? armEl.value : "with_priority";
      box.replaceChildren();
      var ol = add(box, h("ol", "r-steps"));
      (c.arms[arm] || []).forEach(function (s) {
        var li = add(ol, h("li"));
        add(li, h("b", null, s.title || ("Handoff " + s.n + " · " + (s.role === "advisor_continue" ? "advisor (again)" : s.role) + (s.n === 1 && arm === "with_priority" ? " (the only step that receives the priority)" : ""))));
        if (s.prompt) { var d = add(li, h("details")); add(d, h("summary", null, "What it received (input)" + (s.capture === "partial" ? ": only partly captured" : "")));
          if (s.assembled) add(d, h("p", "fine", "Assembled for display from the recorded prompt template and " + s.assembled + ", which the study inserted verbatim; no separate copy of the full input is stored on this site."));
          add(d, h("pre", "r-text", s.prompt)); }
        else if (s.capture === "none") add(li, h("p", "r-cnote", "Its model request was not captured by the instrumentation: unknown."));
        if (s.state !== undefined && s.state !== null) { var ds = add(li, h("details")); add(ds, h("summary", null, "Framework state it could read (not necessarily sent to the model)")); add(ds, h("pre", "r-text", JSON.stringify(s.state, null, 1))); }
        add(li, h("p", "r-outlab", "What it passed on (output):"));
        add(li, h("pre", "r-text", s.text != null ? s.text : "(no output: " + (s.error || "not made") + ")"));
      });
      add(box, h("h4", null, "Deciding-step answers for this case"));
      var dl = add(box, h("ul", "r-decs"));
      c.decisions.forEach(function (d) {
        var li = add(dl, h("li"));
        add(li, h("b", null, SHORT[d.condition] + ": " + (d.outcome || "?") + (d.choice ? " · chose \"" + trunc(d.choice, 80) + "\"" : "")));
        var det = add(li, h("details")); add(det, h("summary", null, "Prompt and answer"));
        if (d.prompt && d.assembled) add(det, h("p", "fine", "Prompt assembled for display from the recorded template and " + d.assembled + ", inserted verbatim by the study."));
        if (d.prompt) add(det, h("pre", "r-text", d.prompt));
        add(det, h("pre", "r-text", d.text != null ? d.text : "(no answer: " + (d.error || "not made") + ")"));
      });
    }
    draw();
  }

  // ------------------------------------------------------------ opening files
  function readBytes(f) {
    return new Promise(function (ok, bad) {
      if (f.size > MAX_FILE) return bad(new R.Refused(f.name + " is larger than 20 MB"));
      var rd = new FileReader();
      rd.onload = function () { ok(new Uint8Array(rd.result)); };
      rd.onerror = function () { bad(new R.Refused(f.name + " could not be read")); };
      rd.readAsArrayBuffer(f);
    });
  }
  function text(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch (e) { throw new R.Refused("a file is not UTF-8 text"); } }
  function openFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return Promise.reject(new R.Refused("no file chosen"));
    if (files.length > 2) return Promise.reject(new R.Refused("choose at most two files: summary.json and records.jsonl, or one saved result"));
    return Promise.all(files.map(readBytes)).then(function (all) {
      var summary = null, records = null, bundle = null, names = [];
      all.forEach(function (b, i) {
        var t = text(b), first = t.split("\n").filter(function (l) { return l.trim(); })[0] || "";
        names.push(files[i].name);
        var obj = null;
        try { obj = JSON.parse(t); } catch (e) { obj = null; }
        if (obj && typeof obj === "object" && !Array.isArray(obj) && obj.format === R.BUNDLE_FORMAT) bundle = t;
        else if (obj && typeof obj === "object" && !Array.isArray(obj) && "summary_format" in obj) summary = t;
        else { var fl = null; try { fl = JSON.parse(first); } catch (e) { fl = null; } if (fl && typeof fl === "object" && "kind" in fl) records = b;
          else if (obj === null && fl === null) throw new R.Refused(files[i].name + " is not valid JSON");
          else throw new R.Refused(files[i].name + " is not a summary.json, a records.jsonl or a saved result"); }
      });
      if (bundle) { if (all.length > 1) throw new R.Refused("open a saved result on its own"); return R.loadRun({ bundleText: bundle, source: names[0] }); }
      if (!summary) throw new R.Refused("summary.json is missing: choose it together with records.jsonl");
      return R.loadRun({ summaryText: summary, recordsBytes: records, source: names.join(" + ") });
    });
  }
  function status(id, text) { $(id).textContent = text; $(id).classList.add("r-ok"); }
  function fail(errId, e) {
    $(errId).classList.remove("r-ok");
    $(errId).textContent = "Not opened: " + (e && e.refused ? e.message : "the file could not be read") + ".";
    if (!(e && e.refused) && window.console) console.error(e);
  }

  $("r-files").addEventListener("change", function () {
    var inp = this;
    openFiles(inp.files).then(function (run) {
      render(vmFromRun(run));
      status("r-err", "Opened " + run.source + (run.records_verified ? "; records checked against the summary." : "; only a summary, so the records could not be checked and handoffs are not shown."));
    }).catch(function (e) { fail("r-err", e); }).then(function () { inp.value = ""; });
  });
  $("r-example").addEventListener("click", function () {
    var E = window.APA_EXAMPLE_RUNS.baseline;
    render(vmFromRun(R.loadRun({ summaryText: E.summary, recordsBytes: R.utf8(E.records), source: "example (fake)" }), E.label));
    status("r-err", "Opened the example fake run. Its records were checked against its summary.");
  });
  $("r-wf-example").addEventListener("click", function () {
    var E = window.APA_EXAMPLE_WORKFLOW.shipped;
    render(vmFromRun(R.loadRun({ summaryText: E.summary, recordsBytes: R.utf8(E.records), source: "example workflow (fake, as shipped)" }), E.label));
    status("r-err", "Opened the example: a four-agent LangGraph system run through priority_check workflow with a fake model. Its records were checked against its summary.");
  });
  $("c-wf-example").addEventListener("click", function () {
    var E = window.APA_EXAMPLE_WORKFLOW.fixed;
    openLater(R.loadRun({ summaryText: E.summary, recordsBytes: R.utf8(E.records), source: "example workflow (fake, after the fix)" }), "Opened the same LangGraph workflow after the change (personalize_decider=false) as the later run. The change removes an undeclared channel: in the shipped version a helper copied the priority straight into the decider's request, which the declared map says should not happen. After it, the decider's request no longer contains the priority, and its decisions still follow it because the cost specialist's report (the declared path) carries the coordinator's lean. This example shows finding and removing an undeclared channel with behaviour preserved, not a drop and recovery. Fake model: not evidence.");
  });
  $("r-study").addEventListener("click", function () {
    status("r-err", "Loading the recorded texts…");
    loadStudy(function (vm) { render(vm); status("r-err", "Opened recorded study data: one pilot scenario, both priorities, both option orders."); });
  });

  // ------------------------------------------------------------ compare
  function showCompare() {
    var out = $("c-out"); out.hidden = false;
    var v = $("c-verdict"); v.replaceChildren();
    if (cur.kind === "study" || !later) {
      var bx = add(v, h("div", "r-verdict v-not_valid"));
      add(bx, h("b", null, "NOT A VALID CONTROLLED COMPARISON"));
      add(bx, h("span", null, "Recorded study data is not a priority_check run: it used the study's own prompts, model setup and record format, so it can't be compared with a kit run as a controlled comparison. Compare two runs of priority_check chain instead."));
      $("c-detail").hidden = true;
      lastCmp = null; return;
    }
    $("c-detail").hidden = false;
    var r = R.compare(cur.run, later.run); lastCmp = r;
    var box = add(v, h("div", "r-verdict v-" + r.verdict));
    add(box, h("b", null, r.verdict_label));
    add(box, h("span", null, r.headline));
    var anyFake = cur.run.summary.fake_run || later.run.summary.fake_run;
    if (anyFake) add(box, h("span", "r-fakeline", "FAKE MODEL OUTPUT " + (cur.run.summary.fake_run && later.run.summary.fake_run ? "ON BOTH SIDES" : "ON ONE SIDE") + ": NOT EVIDENCE about any model."));
    var groups = {}; r.differences.forEach(function (x) { var t = x.field.split(".")[0]; groups[R.MODEL_FIELDS.indexOf(t) >= 0 ? "model" : t] = 1; });
    add(v, h("p", "small", { same_configuration: "Use this to see repeatability: how much the same configuration varies between runs.",
      configuration_change: Object.keys(groups).length > 1 ? "A descriptive comparison. More than one thing differs, so it is not an isolated effect of any single change." :
        "A descriptive comparison: one recorded configuration dimension differs. Unrecorded factors (such as provider-side changes) can't be ruled out.",
      not_valid: "The counts below are shown side by side for reference only. Don't read them as the effect of your change." }[r.verdict]));
    var d = $("c-diffs"); d.replaceChildren();
    if (r.differences.length) {
      add(d, h("h3", null, "Every detected difference (" + r.differences.length + ")"));
      var tw = add(d, h("div", "r-tablewrap")), t = add(tw, h("table", "r-table"));
      var hr = add(add(t, h("thead")), h("tr"));
      ["What", "Kind", "Earlier", "Later"].forEach(function (x) { add(hr, h("th", null, x)); });
      var tb = add(t, h("tbody"));
      r.differences.forEach(function (x) {
        var tr = add(tb, h("tr"));
        var th = add(tr, h("th", null, x.field)); th.scope = "row"; add(th, h("span", "r-cnote", x.message));
        add(tr, h("td", null, x["class"] === R.INVALID ? "makes the comparison invalid" : "configuration change"));
        add(tr, h("td", "r-val", trunc(JSON.stringify(x.baseline), 160)));
        add(tr, h("td", "r-val", trunc(JSON.stringify(x.candidate), 160)));
      });
    }
    var rp = $("c-reps"); rp.replaceChildren();
    var rt = add(add(rp, h("div", "r-tablewrap")), h("table", "r-table"));
    var rh = add(add(rt, h("thead")), h("tr"));
    ["", "Scenarios", "Runs per case", "Option orders", "Decisions per condition and direction"].forEach(function (x) { add(rh, h("th", null, x)); });
    var rb = add(rt, h("tbody"));
    [["Earlier", r.repetitions.baseline], ["Later", r.repetitions.candidate]].forEach(function (p) {
      var tr = add(rb, h("tr")), th = add(tr, h("th", null, p[0])); th.scope = "row";
      [p[1].scenarios, p[1].runs_recorded + " (requested " + p[1].runs_requested + ")", (p[1].orders || []).length, p[1].decisions_per_condition_and_direction].forEach(function (x) { add(tr, h("td", null, String(x))); });
    });
    var single = Math.min(r.repetitions.baseline.runs_requested || 1, r.repetitions.candidate.runs_requested || 1) === 1;
    if (single) add(rp, h("p", "r-warn", R.REPEAT_WARNING));
    else [["Earlier", r.repetitions.baseline], ["Later", r.repetitions.candidate]].forEach(function (p) {
      add(rp, h("p", "small", p[0] + ": in " + p[1].cells_where_every_repetition_gave_the_same_outcome + " of " + p[1].cells + " measured cells, every repetition gave the same outcome."));
    });
    add(rp, h("p", "small", "All decisions come from one scenario. Repeated runs and the two option orders are repeated samples of it, not additional independent scenarios."));
    var cc = $("c-counts"); cc.replaceChildren();
    var ct = add(add(cc, h("div", "r-tablewrap")), h("table", "r-table r-cmp"));
    var ch = add(add(ct, h("thead")), h("tr"));
    ["Condition", "Priority favours", "Earlier", "Later"].forEach(function (x) { add(ch, h("th", null, x)); });
    var cb = add(ct, h("tbody"));
    r.counts.forEach(function (x) {
      var tr = add(cb, h("tr")); var th = add(tr, h("th", null, SHORT[x.condition])); th.scope = "row";
      add(tr, h("td", null, x.direction)); add(tr, h("td", null, outcomeText(x.baseline))); add(tr, h("td", null, outcomeText(x.candidate)));
    });
    var pp = $("c-paired"); pp.replaceChildren();
    var pt = add(add(pp, h("div", "r-tablewrap")), h("table", "r-table"));
    var ph = add(add(pt, h("thead")), h("tr"));
    ["Condition", "Earlier", "Later"].forEach(function (x) { add(ph, h("th", null, x)); });
    var pb = add(pt, h("tbody"));
    r.paired.forEach(function (x) {
      var tr = add(pb, h("tr")), th = add(tr, h("th", null, SHORT[x.condition])); th.scope = "row";
      if (x.condition === "workflow_no_priority") { var na = add(tr, h("td", null, "not applicable: one shared execution per case (no priority given)")); na.colSpan = 2; return; }
      [x.baseline, x.candidate].forEach(function (q) { add(tr, h("td", null, q.both_priorities_got_their_own_option + " of " + q.readable_cases + " readable pair(s) (" + q.cases + " cases)")); });
    });
    var nl = $("c-notes"); nl.replaceChildren();
    r.notes.forEach(function (n) { add(nl, h("li", null, n)); });
  }
  function openLater(run, msg) {
    later = { run: run }; showCompare(); status("c-err", msg);
    $("c-verdict").setAttribute("tabindex", "-1"); $("c-verdict").focus();
  }
  $("c-files").addEventListener("change", function () {
    var inp = this;
    if (cur && cur.kind === "study") { later = null; showCompare(); inp.value = ""; return; }
    openFiles(inp.files).then(function (run) { openLater(run, "Opened " + run.source + " as the later run" + (run.records_verified ? "; records checked." : "; only a summary, so its records were not checked.")); })
      .catch(function (e) { later = null; lastCmp = null; $("c-out").hidden = true; fail("c-err", e); }).then(function () { inp.value = ""; });
  });
  $("c-example").addEventListener("click", function () {
    if (cur && cur.kind === "study") { later = null; showCompare(); return; }
    var E = window.APA_EXAMPLE_RUNS.changed;
    openLater(R.loadRun({ summaryText: E.summary, recordsBytes: R.utf8(E.records), source: "example (fake, changed setting)" }), "Opened the example fake run with one fake setting changed as the later run.");
  });
  $("c-swap").addEventListener("click", function () {
    if (!later || !cur.run) return;
    var a = cur.run, b = later.run;
    render(vmFromRun(b)); later = { run: a }; showCompare();
    status("c-err", "Swapped: the earlier run is now " + b.source + ".");
  });

  // ------------------------------------------------------------ exports
  function download(name, body, type) {
    var url = URL.createObjectURL(new Blob([body], { type: type }));
    var a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function slug() {
    var s = cur.run ? cur.run.summary : null;
    return ((s ? s.scenario_id + "-" + (s.fake_run ? "fake" : s.model_requested) + "-" + (s.run_id || "") : "study-3b").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70)) || "result";
  }
  $("r-save").addEventListener("click", function () {
    if (!cur || !cur.run || !cur.run.records_verified) return;
    download(slug() + ".result.json", R.bundleText(cur.run, new Date().toISOString().slice(0, 10)), "application/json");
    status("r-err", "Saved the result as a .json file.");
  });
  $("c-save").addEventListener("click", function () {
    if (!lastCmp) return;
    var o = JSON.parse(JSON.stringify(lastCmp));
    o.baseline = { source: cur.run.source, run_id: cur.run.summary.run_id, records_verified: cur.run.records_verified };
    o.candidate = { source: later.run.source, run_id: later.run.summary.run_id, records_verified: later.run.records_verified };
    download(((cur.run.summary.run_id || "a") + "-vs-" + (later.run.summary.run_id || "b")).toLowerCase().replace(/[^a-z0-9-]+/g, "-") + ".comparison.json", JSON.stringify(o, null, 1) + "\n", "application/json");
    status("c-err", "Saved the comparison as a .json file.");
  });
  $("c-report").addEventListener("click", function () { $("r-report").click(); });
  $("r-report").addEventListener("click", function () {
    if (!cur) return;
    var doc = document.implementation.createHTMLDocument("Result report");
    var meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.appendChild(meta);
    var css = "body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1d1f23}" +
      "h1{font-size:1.3rem}h2,h3{font-size:1rem;margin-top:18px}table{border-collapse:collapse;font-size:.85rem}th,td{border-bottom:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}" +
      "pre{white-space:pre-wrap;border:1px solid #ccc;border-radius:6px;padding:6px 8px;font-size:.8rem}.r-kind{border:2px solid #333;padding:8px 10px;margin:8px 0}.r-kind b{display:block}" +
      ".small,.r-cnote,.fine{color:#555;font-size:.85rem;display:block}.r-warn{border-left:4px solid #b00;padding-left:8px}dt{font-weight:700}dd{margin:0 0 6px}";
    // clone the rendered, textContent-only sections; drop buttons, file inputs and selectors
    var b = doc.body;
    function e(tag, t) { var n = doc.createElement(tag); n.textContent = t; return b.appendChild(n); }
    e("h1", "Priority test result: " + (cur.run ? cur.run.summary.scenario_id : "recorded study data"));
    e("p", "Exported from the Anchor-Preservation Auditor's Inspect and compare page (static, client-side). " + (cur.workflow ?
      "The result came from the reader's own workflow, run through its adapter with priority_check workflow, as the adapter describes it." :
      cur.kind === "study" ? "The result is recorded study data (Study 3B pilot)." : "The result came from the fixed six-handoff reference workflow, not from the reader's own agents."));
    [$("r-kind"), $("r-prov")].concat(Array.prototype.slice.call(document.querySelectorAll("#r-out .r-q"))).forEach(function (n) { b.appendChild(doc.importNode(n, true)); });
    if (lastCmp && !$("c-out").hidden) {
      e("h2", "Comparison with a later run");
      e("p", "Earlier run: " + (cur.run.summary.run_id || "?") + " (" + cur.run.source + "). Later run: " + (later.run.summary.run_id || "?") + " (" + later.run.source + ").");
      b.appendChild(doc.importNode($("c-out"), true));
    }
    Array.prototype.forEach.call(b.querySelectorAll("button, input, select, label.r-sel, fieldset, .wf-actions"), function (n) { n.remove(); });
    Array.prototype.forEach.call(b.querySelectorAll("details"), function (n) { n.setAttribute("open", ""); });
    var html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace("</head>", "<style>" + css + "</style></head>");
    download(slug() + ".report.html", html, "text/html");
    status("r-err", "Saved a readable report as an .html file.");
  });

  window.__inspectState = function () {   // read-only snapshot, for the browser tests
    return { kind: cur && cur.kind, verdict: lastCmp && lastCmp.verdict, differences: lastCmp && lastCmp.differences.map(function (d) { return d.field; }) };
  };
})();
