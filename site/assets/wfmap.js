// Workflow Map: the file format and the exposure rules. Pure functions only: no DOM, no network, no storage.
// Shared by map.html (build a map) and trace.html (start a trace review from a map file); unit-tested in Node by
// release/tools/test_wfmap.mjs. The rules only read the workflow structure the person declares. They never look at
// model behaviour, and the absence of literal priority wording is never taken as evidence that a priority was lost.
(function (root) {
  "use strict";
  var FORMAT = "apa-workflow-map/1";
  var MAX_AGENTS = 12;
  var LIMITS = { title: 200, priority: 2000, decision: 4000, name: 80, role: 80, instructions: 20000, note: 1000,
    question: 4000, option: 600, opposite: 2000 };
  var ENUMS = {
    gets_priority: ["yes", "no", "unknown", ""],
    inputs_from: ["some", "none", "unknown", ""],
    other_context: ["yes", "no", "unknown", ""],
    decision_role: ["final", "contributes", "no", "unknown", ""]
  };
  var TOP_KEYS = ["format", "title", "priority", "decision", "agents", "test"];
  var AGENT_KEYS = ["name", "role", "instructions", "gets_priority", "inputs_from", "sources", "other_context", "other_context_note", "decision_role"];
  var TEST_KEYS = ["question", "option_a", "option_b", "priority_favours", "opposite_priority"];

  function blankAgent(n) {
    return { name: "Agent " + n, role: "", instructions: "", gets_priority: "", inputs_from: "", sources: [], other_context: "",
      other_context_note: "", decision_role: "" };
  }
  function blankTest() { return { question: "", option_a: "", option_b: "", priority_favours: "", opposite_priority: "" }; }
  function blank() { return { format: FORMAT, title: "", priority: "", decision: "", agents: [blankAgent(1)], test: blankTest() }; }

  // ------------------------------------------------------------ strict validation of an imported file
  // Returns {ok: true, map} or {ok: false, errors: [...]}. Unknown keys, wrong types, over-long text, out-of-range or
  // forward-pointing sources are refused, never repaired: an imported file is data and is never executed.
  function validate(x) {
    var errs = [];
    function str(v, where, max, required) {
      if (typeof v !== "string") { errs.push(where + " must be text"); return ""; }
      if (v.length > max) errs.push(where + " is longer than " + max + " characters");
      if (required && !v.trim()) errs.push(where + " is empty");
      return v;
    }
    function keys(o, allowed, where) {
      Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) errs.push(where + ": unknown field \"" + k + "\""); });
      allowed.forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(o, k)) errs.push(where + ": missing field \"" + k + "\""); });
    }
    function isObj(o) { return o !== null && typeof o === "object" && !Array.isArray(o); }
    if (!isObj(x)) return { ok: false, errors: ["the file is not a workflow map (expected a JSON object)"] };
    if (x.format !== FORMAT) return { ok: false, errors: ["the file is not a workflow map in format " + FORMAT] };
    keys(x, TOP_KEYS, "map");
    var out = { format: FORMAT, title: str(x.title, "title", LIMITS.title), priority: str(x.priority, "priority", LIMITS.priority),
      decision: str(x.decision, "decision", LIMITS.decision), agents: [], test: blankTest() };
    if (!Array.isArray(x.agents) || x.agents.length < 1 || x.agents.length > MAX_AGENTS) {
      errs.push("agents must be a list of 1 to " + MAX_AGENTS);
    } else {
      x.agents.forEach(function (a, i) {
        var w = "agent " + (i + 1);
        if (!isObj(a)) { errs.push(w + " is not an object"); return; }
        keys(a, AGENT_KEYS, w);
        var b = { name: str(a.name, w + " name", LIMITS.name, true), role: str(a.role, w + " role", LIMITS.role),
          instructions: str(a.instructions, w + " instructions", LIMITS.instructions),
          other_context_note: str(a.other_context_note, w + " context note", LIMITS.note), sources: [] };
        Object.keys(ENUMS).forEach(function (k) {
          if (ENUMS[k].indexOf(a[k]) < 0) errs.push(w + " " + k + " must be one of: " + ENUMS[k].filter(Boolean).join(", ") + " (or empty)");
          b[k] = a[k];
        });
        if (!Array.isArray(a.sources)) errs.push(w + " sources must be a list");
        else {
          a.sources.forEach(function (s) {
            if (typeof s !== "number" || s !== Math.floor(s) || s < 0 || s >= i) errs.push(w + " sources may only name earlier agents (got " + JSON.stringify(s) + ")");
            else if (b.sources.indexOf(s) >= 0) errs.push(w + " sources lists agent " + (s + 1) + " twice");
            else b.sources.push(s);
          });
          if (b.inputs_from !== "some" && b.sources.length) errs.push(w + " lists sources but inputs_from is not \"some\"");
        }
        out.agents.push(b);
      });
    }
    if (!isObj(x.test)) errs.push("test must be an object");
    else {
      keys(x.test, TEST_KEYS, "test");
      out.test = { question: str(x.test.question, "test question", LIMITS.question), option_a: str(x.test.option_a, "test option A", LIMITS.option),
        option_b: str(x.test.option_b, "test option B", LIMITS.option), priority_favours: x.test.priority_favours,
        opposite_priority: str(x.test.opposite_priority, "test opposite priority", LIMITS.opposite) };
      if (["A", "B", ""].indexOf(x.test.priority_favours) < 0) errs.push("test priority_favours must be A, B or empty");
    }
    return errs.length ? { ok: false, errors: errs } : { ok: true, map: out };
  }

  // ------------------------------------------------------------ the exposure rules (deterministic, declared structure only)
  // explicit : the person says this agent receives the priority directly.
  // via      : it does not receive it directly, but it reads the output of an agent that is explicit or via, or it has
  //            other context the person says could state the priority. Whether the priority actually arrives depends on
  //            what that output or context says, which a structural map cannot see.
  // none     : by the person's own description, neither the priority nor any route that could carry it reaches the agent.
  // unknown  : something needed to decide is not specified; the map asks instead of guessing.
  var PLACEHOLDER = /\{\{?\s*(user_?)?priorit(y|ies)\s*\}?\}|\$\{?\s*(user_?)?priorit(y|ies)\b|<\s*(user_?)?priorit(y|ies)\s*>/i;
  function norm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
  function agentLabel(m, i) { return "Agent " + (i + 1) + (m.agents[i].name && m.agents[i].name !== "Agent " + (i + 1) ? " (" + m.agents[i].name + ")" : ""); }

  function analyse(m) {
    var res = [], questions = [], findings = [];
    m.agents.forEach(function (a, i) {
      var r = { exposure: "unknown", hops: null, path: null, reasons: [] };
      var srcs = a.inputs_from === "some" ? a.sources : [];
      var exposedSrc = srcs.filter(function (s) { return res[s].exposure === "explicit" || res[s].exposure === "via"; });
      var unknownSrc = srcs.filter(function (s) { return res[s].exposure === "unknown"; });
      var q = function (t) { questions.push({ agent: i, text: t }); };
      if (a.gets_priority === "") q(agentLabel(m, i) + ": does it receive the user's priority directly (in its prompt or input)?");
      else if (a.gets_priority === "unknown") q(agentLabel(m, i) + ": you marked \"not sure\" whether it receives the priority directly. Check its prompt template or input.");
      if (a.inputs_from === "") q(agentLabel(m, i) + ": does it receive any earlier agent's output?");
      else if (a.inputs_from === "unknown") q(agentLabel(m, i) + ": you marked \"not sure\" which earlier outputs it receives.");
      else if (a.inputs_from === "some" && !a.sources.length) q(agentLabel(m, i) + ": you said it receives earlier outputs but did not tick which agents.");
      if (a.other_context === "") q(agentLabel(m, i) + ": does it have other context that could state the priority (memory, a shared document, retrieved files, a system prompt)?");
      else if (a.other_context === "unknown") q(agentLabel(m, i) + ": you marked \"not sure\" whether it has other context that could state the priority. Check its memory, shared documents, retrieved files and system prompt.");
      if (a.decision_role === "") q(agentLabel(m, i) + ": does it make or contribute to the final decision?");
      else if (a.decision_role === "unknown") q(agentLabel(m, i) + ": you marked \"not sure\" whether it makes or contributes to the final decision.");
      // literal hints: they can only prompt a question, never change a classification
      var instr = a.instructions || "";
      if (a.gets_priority !== "yes" && instr && (PLACEHOLDER.test(instr) || (norm(m.priority).length >= 12 && norm(instr).indexOf(norm(m.priority)) >= 0))) {
        q(agentLabel(m, i) + ": its instructions appear to contain the priority or a priority placeholder (literal match), but it is not marked as receiving the priority directly. Is that intended?");
      }
      if (a.gets_priority === "yes") {
        r.exposure = "explicit"; r.hops = 0; r.path = [i];
        r.reasons.push("You said it receives the priority directly.");
      } else if (a.gets_priority === "no") {
        if (exposedSrc.length) {
          var best = exposedSrc.reduce(function (b, s) { return res[s].hops < res[b].hops ? s : b; }, exposedSrc[0]);
          r.exposure = "via"; r.hops = res[best].hops + 1; r.path = res[best].path.concat([i]);
          r.reasons.push("It reads the output of " + exposedSrc.map(function (s) { return "agent " + (s + 1); }).join(", ") +
            ". The priority reaches it only if that output carries it.");
        }
        if (a.other_context === "yes") {
          if (r.exposure !== "via") { r.exposure = "via"; r.hops = 1; r.path = [i]; r.context_only = true; }
          r.reasons.push("You said it has other context that could state the priority" + (a.other_context_note ? " (" + a.other_context_note + ")" : "") + ".");
        }
        if (a.other_context === "unknown" && r.exposure === "via") r.reasons.push("You are not sure whether it also has other context that could state the priority.");
        if (r.exposure !== "via") {
          if (unknownSrc.length || a.inputs_from === "unknown" || a.inputs_from === "" || (a.inputs_from === "some" && !a.sources.length) ||
              a.other_context === "unknown" || a.other_context === "") {
            r.exposure = "unknown";
            r.reasons.push("Not enough is specified to tell whether any route could carry the priority.");
          } else {
            r.exposure = "none";
            r.reasons.push("As you described it, neither the priority nor any route that could carry it reaches this agent.");
          }
        }
      } else {
        r.reasons.push("Whether it receives the priority directly is not specified.");
      }
      res.push(r);
    });

    var deciders = [];
    m.agents.forEach(function (a, i) { if (a.decision_role === "final") deciders.push(i); });
    var readBy = m.agents.map(function () { return []; });
    m.agents.forEach(function (a, i) { (a.inputs_from === "some" ? a.sources : []).forEach(function (s) { readBy[s].push(i); }); });

    if (!deciders.length) findings.push({ kind: "question", text: "No agent is marked as making the final decision. Mark one, so the map can show how the priority reaches it." });
    if (deciders.length > 1) findings.push({ kind: "note", text: "More than one agent is marked as making the final decision (" + deciders.map(function (d) { return "agent " + (d + 1); }).join(", ") + "). Each is described separately below." });
    deciders.forEach(function (d) {
      var r = res[d], who = agentLabel(m, d);
      if (r.exposure === "explicit") {
        findings.push({ kind: "explicit", agent: d, text: who + " makes the final decision and receives the priority directly. Receiving it does not show that the decision uses it: a behavioural test compares decisions with and without the priority." });
      } else if (r.exposure === "via") {
        var route = r.path ? r.path.map(function (p) { return p === d ? "the decision" : "agent " + (p + 1); }).join(" → ") : "";
        findings.push({ kind: "via", agent: d, text: who + " makes the final decision but does not receive the priority directly. It can reach the decision only through " +
          (r.context_only ? "the other context you described" : r.hops + " earlier output" + (r.hops === 1 ? "" : "s") + " (shortest declared route: user → " + route + ")") +
          ". Whether it survives depends on what those outputs say; this map cannot see that." });
        findings.push({ kind: "action", agent: d, text: "Test it: give " + who + " the same input twice, once as it is and once with one line repeating the priority, and compare the decisions. If they differ, consider passing the priority to the deciding step directly, then test again." });
      } else if (r.exposure === "none") {
        findings.push({ kind: "none", agent: d, text: who + " makes the final decision, and as you described it nothing gives it the priority. If the decision should reflect the priority, consider passing it directly, then test whether the decision changes." });
      } else {
        findings.push({ kind: "question", agent: d, text: "How the priority reaches " + who + ", which makes the final decision, can't be shown until the questions below are answered." });
      }
    });
    m.agents.forEach(function (a, i) {
      if (res[i].exposure === "explicit" && deciders.length && deciders.indexOf(i) < 0 && !readBy[i].length) {
        findings.push({ kind: "note", agent: i, text: agentLabel(m, i) + " receives the priority, but no later agent is marked as reading its output." });
      }
    });
    return { agents: res, deciders: deciders, findings: findings, questions: questions };
  }

  // ------------------------------------------------------------ export for the priority_check `chain` command
  // The chain command runs the study's fixed six-handoff workflow on this two-option scenario; it does not run the
  // person's own agents. Fields and checks mirror priority_check.chain's scenario validation.
  function chainScenario(m) {
    var t = m.test, errs = [];
    var q = (t.question || m.decision || "").trim();
    if (!q) errs.push("the decision to test is empty");
    if (!t.option_a.trim() || !t.option_b.trim()) errs.push("both options are needed");
    else if (t.option_a.trim() === t.option_b.trim()) errs.push("the two options are identical");
    if (!m.priority.trim()) errs.push("the priority is empty");
    if (t.priority_favours !== "A" && t.priority_favours !== "B") errs.push("say which option the priority favours");
    if (!t.opposite_priority.trim()) errs.push("write the opposite priority");
    else if (t.opposite_priority.trim() === m.priority.trim()) errs.push("the opposite priority is identical to the priority");
    if (errs.length) return { ok: false, errors: errs };
    var slug = (m.title || q).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "my-scenario";
    var pa = t.priority_favours === "A" ? m.priority.trim() : t.opposite_priority.trim();
    var pb = t.priority_favours === "A" ? t.opposite_priority.trim() : m.priority.trim();
    return { ok: true, scenario: { scenario_id: slug, question: q, option_a: t.option_a.trim(), option_b: t.option_b.trim(), priority_A: pa, priority_B: pb } };
  }

  // ------------------------------------------------------------ observed: an execution trace (apa-trace/1)
  // A trace records what each agent's model request actually contained and what framework state it could see. Literal
  // matching can show that the priority's exact text WAS present; it can never show that the priority's content was
  // absent (it may be paraphrased, or not captured). Missing instrumentation is reported as unknown, never guessed.
  var TRACE_FORMAT = "apa-trace/1";
  var MIN_OVERLAP = 30;          // characters of an earlier agent's output that count as "its output is in this request"
  function validateTrace(x) {
    var e = [];
    if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, errors: ["the file is not a JSON object"] };
    if (x.format !== TRACE_FORMAT) e.push("format must be " + TRACE_FORMAT);
    var control = Array.isArray(x.control_priorities) && x.control_priorities.length > 0 && x.control_priorities.every(function (p) { return typeof p === "string" && p.trim(); });
    if (typeof x.priority !== "string" || (!x.priority.trim() && !control))
      e.push("the trace must name the priority it was run with (\"priority\"), or, for a no-priority execution, the priorities to check for (\"control_priorities\")");
    if (!Array.isArray(x.agents) || !x.agents.length || x.agents.length > 50) e.push("agents must be a list of 1 to 50 traced agents");
    else x.agents.forEach(function (a, i) {
      if (!a || typeof a !== "object" || typeof a.id !== "string" || !a.id.trim()) e.push("traced agent " + (i + 1) + " needs an id");
      else if (a.request_messages !== null && a.request_messages !== undefined && (!Array.isArray(a.request_messages) ||
               a.request_messages.some(function (m) { return !m || typeof m !== "object" || (m.content !== undefined && typeof m.content !== "string"); })))
        e.push("traced agent " + a.id + ": request_messages must be a list of {role, content}");
    });
    var size = 0; try { size = JSON.stringify(x).length; } catch (er) { size = Infinity; }
    if (size > 5000000) e.push("the trace is larger than 5 MB");
    return { ok: !e.length, errors: e };
  }
  function reqText(a) {
    return Array.isArray(a.request_messages) ? a.request_messages.map(function (m) { return typeof m.content === "string" ? m.content : ""; }).join("\n") : null;
  }
  function observe(m, trace) {
    var control = !norm(trace.priority);
    var Ps = (control ? trace.control_priorities : [trace.priority]).map(norm).filter(function (p) { return p.length > 0; });
    var has = function (text) { return Ps.some(function (p) { return text.indexOf(p) >= 0; }); };
    var out = [], byId = {}, raw = trace.agents;
    // an agent id that appears more than once (a loop or a retry) is one agent: its occurrences are combined
    var groups = [], gi = {};
    raw.forEach(function (a, i) { var k = norm(a.id); if (!(k in gi)) { gi[k] = groups.length; groups.push({ id: a.id, idx: [] }); } groups[gi[k]].idx.push(i); });
    var groupOf = raw.map(function (a) { return gi[norm(a.id)]; });
    var traced = groups.map(function (g, gk) {
      var t = { id: g.id, role: raw[g.idx[0]].role || "", occurrences: g.idx.length, capture: "full", inReq: false, inState: false, stateCaptured: true, from: [] };
      g.idx.forEach(function (i) {
        var a = raw[i], req = reqText(a), st = (a.state_visible !== null && a.state_visible !== undefined) ? JSON.stringify(a.state_visible) : null;
        var cap = req === null ? "none" : a.request_complete === true ? "full" : "partial";
        if (cap === "none" || (cap === "partial" && t.capture === "full")) t.capture = cap;
        if (req !== null && has(norm(req))) t.inReq = true;
        if (st !== null && has(norm(st))) t.inState = true;
        if (st === null) t.stateCaptured = false;
        for (var j = 0; j < i; j++) {
          var o = norm(raw[j].output || ""), src = groupOf[j];
          if (src !== gk && req !== null && o.length >= MIN_OVERLAP && norm(req).indexOf(o.slice(0, Math.min(o.length, 160))) >= 0 && t.from.indexOf(src) < 0) t.from.push(src);
        }
      });
      return t;
    });
    traced.forEach(function (t, i) {
      var cls, why;
      var exposedFrom = t.from.filter(function (j) { return ["explicit", "via_message"].indexOf(traced[j].observed) >= 0; });
      if (t.inReq) { cls = "explicit"; why = control ? "In this NO-PRIORITY execution, a priority's exact text is in its recorded model request: the control is contaminated (carryover or leakage)." : "The priority's exact text is in its recorded model request."; }
      else if (exposedFrom.length) {
        cls = "via_message";
        why = "Its request contains the output of " + exposedFrom.map(function (j) {
          return traced[j].id + (traced[j].observed === "explicit" ? " (whose own request contained the priority's text)" : " (which may itself carry it through an earlier agent)");
        }).join(" and ") + ". The priority's exact text is NOT in its request; it may be conveyed in that output, possibly paraphrased. This is a possible route, not proof that it was.";
      }
      else if (t.inState && t.capture === "full") { cls = "state_only"; why = "The priority is in the framework state this agent could read, but not in its recorded model request."; }
      else if (t.capture === "full") { cls = "none_observed"; why = "Its full request was captured and contains neither the priority's text nor an exposed agent's output. It may still carry the priority in other words."; }
      else { cls = "unknown"; why = t.capture === "none" ? "Its model request was not captured, so this can't be determined." : "Only part of its request was captured; the priority's text was not found in that part."; }
      t.observed = cls; t.why = why;
      if (t.inState && cls !== "state_only") t.also = cls === "unknown" ? "The priority is in the state it could read; whether it was sent to the model is unknown." : "The priority is also in the state it could read.";
      if (!t.stateCaptured) t.stateNote = "Its visible state was not captured.";
      if (t.capture === "partial" && cls !== "unknown") t.stateNote = (t.stateNote ? t.stateNote + " " : "") + "Its request was only partly captured.";
      if (t.occurrences > 1) t.stateNote = (t.stateNote ? t.stateNote + " " : "") + "It appears " + t.occurrences + " times in the trace (a loop or retry); the occurrences are combined.";
      byId[norm(t.id)] = i;
    });
    // match declared agents by name (or by id), case-insensitive
    var rows = [], discrepancies = [], matched = {};
    var probe = trace.source && (trace.source.condition === "direct" || trace.source.condition === "restored") ? trace.source.condition : null;
    if (probe) discrepancies.push({ agent: null, kind: "probe", text: "This trace is from the kit's " + probe + " probe: the kit itself gave the priority to the decision step. It shows the probe, not your design; use a trace from a whole-workflow execution to check your routing." });
    if (control) discrepancies.push({ agent: null, kind: "control", text: "This trace is from a NO-PRIORITY execution: any priority text found in it means the control was contaminated." });
    if (!control && norm(m.priority) && norm(m.priority) !== norm(trace.priority))
      discrepancies.push({ agent: null, kind: "priority_mismatch", text: "This trace was run with a different priority (\u201c" + trace.priority + "\u201d) from your map's (\u201c" + m.priority + "\u201d). The observed column checks the trace's priority." });
    var opp = !control && typeof trace.opposite_priority === "string" ? norm(trace.opposite_priority) : "";
    if (opp) raw.forEach(function (a) {                  // the OPPOSITE priority should appear nowhere in this execution
      var req = reqText(a), st = (a.state_visible !== null && a.state_visible !== undefined) ? JSON.stringify(a.state_visible) : null;
      var inReq = req !== null && norm(req).indexOf(opp) >= 0, inSt = st !== null && norm(st).indexOf(opp) >= 0;
      if (inReq || inSt) discrepancies.push({ agent: null, kind: "opposite_priority", text: "Agent " + a.id + ": the OPPOSITE priority's exact text is in its " + (inReq ? "model request" : "visible state") + ". This execution was given the other priority, so this points to carryover or leakage between executions." });
    });

    m.agents.forEach(function (a, i) {
      var k = byId[norm(a.name)];
      var row = { agent: i, name: a.name, traced: k === undefined ? null : traced[k] };
      rows.push(row);
      if (k === undefined) { discrepancies.push({ agent: i, kind: "untraced", text: agentLabel(m, i) + " is in your map but not in the trace, so nothing about it was observed." }); return; }
      matched[k] = true;
      var t = traced[k], decl = a.gets_priority;
      if (control && (t.inReq || t.inState))
        discrepancies.push({ agent: i, kind: "control_leak", text: agentLabel(m, i) + ": a priority's exact text is in its " + (t.inReq ? "model request" : "visible state") + " although this execution had no priority." });
      var declaredOut = a.inputs_from === "some" ? a.sources.map(function (s) { return norm(m.agents[s].name); }) : [];
      // 2026-11-23: priority text that sits INSIDE a declared source's recorded output arrived through a declared route;
      // only priority text outside those outputs is a sign of an undeclared channel
      var outside = function () {
        return groups[k].idx.some(function (ri) {
          var req = reqText(raw[ri]); if (req === null) return false;
          var r = norm(req);
          raw.forEach(function (o, j) { if (j < ri && declaredOut.indexOf(norm(o.id)) >= 0) { var on = norm(o.output || ""); if (on) r = r.split(on).join(" \u0000 "); } });
          return has(r);
        });
      };
      if (!control && decl !== "yes" && t.observed === "explicit" && !(probe && a.decision_role === "final")) {
        if (declaredOut.length && !outside())
          t.also = (t.also ? t.also + " " : "") + "The priority's text in its request is inside the recorded output of a declared input (" +
            a.sources.map(function (s) { return m.agents[s].name; }).join(", ") + "), so it arrived through a route you declared.";
        else
          discrepancies.push({ agent: i, kind: "unexpected_priority", text: "You declared that " + agentLabel(m, i) + " does not receive the priority directly" +
            (a.inputs_from === "some" && a.sources.length ? " (it receives only " + a.sources.map(function (s) { return "agent " + (s + 1) + "'s output"; }).join(", ") + ")" : "") +
            ". Its recorded model request contains the original priority's text outside the recorded outputs of its declared inputs: a possible undeclared channel." });
      }
      if (!control && !probe && decl === "yes" && t.capture === "full" && !t.inReq)
        discrepancies.push({ agent: i, kind: "missing_priority", text: "You declared that " + agentLabel(m, i) + " receives the original priority, but the captured request does not show its text. It may be paraphrased or supplied another way; check the prompt." });
      if (decl === "yes" && t.capture !== "full" && !t.inReq)
        discrepancies.push({ agent: i, kind: "unverifiable", text: agentLabel(m, i) + ": you declared it receives the priority; its request was not fully captured, so this can't be checked." });
      var declaredSrc = a.inputs_from === "some" ? a.sources.map(function (s) { return norm(m.agents[s].name); }) : [];
      t.from.forEach(function (j) {
        if (declaredSrc.indexOf(norm(traced[j].id)) >= 0) return;
        // 2026-11-23: text of an earlier agent that reached this one INSIDE a declared input's output (a pass-through,
        // e.g. a compressor that forwards a prefix) arrived through a declared route, not an undeclared one
        var head = norm(raw[groups[j].idx[0]].output || "").slice(0, 160);
        var via = declaredSrc.filter(function (n) { var k = byId[n]; return k !== undefined && groups[k].idx.some(function (ri) { return norm(raw[ri].output || "").indexOf(head) >= 0; }); });
        if (head && via.length) { t.also = (t.also ? t.also + " " : "") + "Text from " + traced[j].id + " reached it inside the output of " + via.map(function (n) { return traced[byId[n]].id; }).join(", ") + ", a declared input."; return; }
        discrepancies.push({ agent: i, kind: "undeclared_input", text: "The recorded request of " + agentLabel(m, i) + " contains output from " + traced[j].id + ", which you did not declare as one of its inputs." });
      });
      if (t.capture === "full") declaredSrc.forEach(function (n) {
        var j = byId[n];
        if (j !== undefined && t.from.indexOf(j) < 0 && norm(raw[groups[j].idx[0]].output || "").length >= MIN_OVERLAP)
          discrepancies.push({ agent: i, kind: "declared_input_absent", text: "You declared that " + agentLabel(m, i) + " reads " + traced[j].id + "'s output, but the captured request does not contain it verbatim (it may be summarised or reformatted)." });
      });
      if (!control && t.inState && !t.inReq && t.capture === "full" && a.other_context === "no")
        discrepancies.push({ agent: i, kind: "state_available", text: "The framework state " + agentLabel(m, i) + " could read contains the priority, though you declared no other context. Its exact text was not in the model request (a paraphrase could still be): available in state, not sent verbatim." });
    });
    traced.forEach(function (t, k) { if (!matched[k]) discrepancies.push({ agent: null, kind: "unmapped", text: "The trace has an agent \"" + t.id + "\" that is not in your map." }); });
    var incomplete = traced.filter(function (t) { return t.capture !== "full"; }).map(function (t) { return t.id; });
    return { traced: traced, rows: rows, discrepancies: discrepancies, incomplete: incomplete,
      caveat: "Observed from one recorded execution. Exact-text matching shows where the priority's words were present; it can't show that the meaning was absent, and uncaptured requests are unknown." +
        (!control && !opp ? " This trace does not name the opposite priority, so leakage of the opposite priority was not checked (traces saved from Inspect include it)." : "") };
  }

  var api = { FORMAT: FORMAT, TRACE_FORMAT: TRACE_FORMAT, MAX_AGENTS: MAX_AGENTS, LIMITS: LIMITS, blank: blank, blankAgent: blankAgent, validate: validate,
    analyse: analyse, chainScenario: chainScenario, agentLabel: agentLabel, validateTrace: validateTrace, observe: observe };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.APAWorkflowMap = api;
})(this);
