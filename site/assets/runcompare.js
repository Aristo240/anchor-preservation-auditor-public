// Run loading, verification and comparison for priority_check `chain` results, in the browser. Pure functions, no DOM,
// no network, no storage. The rules mirror priority_check_kit/priority_check/compare.py exactly (same fields, classes,
// messages and notes); release/tools/test_runcompare.cjs and the kit's tests/test_runcompare_parity.py check that both
// give the same verdicts and differences on the same runs. Imported data is parsed as JSON only and never executed.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.APARunCompare = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BUNDLE_FORMAT = "apa-result/1";
  var WF_FORMAT = "priority_check.workflow.summary/1";
  var WF_CONDITIONS = ["workflow", "workflow_no_priority", "direct", "restored"];
  var COMPARE_FORMAT = "priority_check.chain.compare/2";
  var CONDITIONS = ["direct", "delegated", "restored", "direct_no_priority", "chain_no_priority"];
  var DIRECTIONS = ["A", "B"];
  var OUTCOMES = ["MATCHED", "OPPOSITE", "UNCLEAR", "INVALID", "MISSING"];
  var SAME = "same_configuration", CHANGED = "configuration_change", INVALID = "not_valid";
  var VERDICT_LABELS = {}; VERDICT_LABELS[SAME] = "SAME CONFIGURATION"; VERDICT_LABELS[CHANGED] = "CONFIGURATION CHANGE";
  VERDICT_LABELS[INVALID] = "NOT A VALID CONTROLLED COMPARISON";
  var REPEAT_WARNING = "Differences may reflect run-to-run variation. Repeat each configuration to assess consistency.";
  var REQUIRED_FIELDS = ["summary_format", "kit_version", "fake_run", "scenario_id", "scenario_sha256", "prompt_templates_sha256",
    "provider", "model_requested", "models_served", "openrouter_provider_slug", "served_providers", "settings",
    "request_parameters_sent", "conditions", "directions", "orders_requested", "runs_requested",
    "planned_calls", "records_sha256", "calls_recorded", "counts", "paired"];
  // [field, label, class]: the same table as compare.FIELDS
  var FIELDS = [["fake_run", "fake or real run", INVALID], ["summary_format", "summary and outcome format", INVALID],
    ["scenario_sha256", "scenario content (sha256)", INVALID], ["scenario_id", "scenario id", INVALID],
    ["conditions", "conditions", INVALID], ["directions", "priority directions", INVALID],
    ["orders_requested", "option orders", INVALID],
    ["provider", "provider", CHANGED], ["model_requested", "model requested", CHANGED],
    ["models_served", "model(s) served", CHANGED], ["openrouter_provider_slug", "OpenRouter provider slug", CHANGED],
    ["served_providers", "served provider(s)", CHANGED], ["settings", "settings", CHANGED],
    ["request_parameters_sent", "request parameters sent", CHANGED],
    ["prompt_templates_sha256", "reference-workflow prompt templates (sha256)", CHANGED],
    ["kit_version", "kit version", CHANGED], ["runs_requested", "repetitions (runs per case)", CHANGED],
    ["workflow_fingerprint", "workflow configuration (the adapter's description: agents, models, settings)", CHANGED],
    ["config", "configuration passed to the workflow (--config)", CHANGED],
    ["code", "workflow code (sha256 of the .py files in the adapter's folder)", CHANGED]];
  var MODEL_FIELDS = ["provider", "model_requested", "models_served", "openrouter_provider_slug", "served_providers"];
  var MAX_BYTES = 20 * 1024 * 1024;

  function Refused(msg) { this.message = msg; this.refused = true; }

  // ---------------------------------------------------------------- sha256 (FIPS 180-4) over bytes
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70,
    0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(bytes) {
    var n = bytes.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(bytes); m[n] = 0x80;
    var bits = n * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    m[total - 8] = hi >>> 24; m[total - 7] = hi >>> 16; m[total - 6] = hi >>> 8; m[total - 5] = hi;
    m[total - 4] = lo >>> 24; m[total - 3] = lo >>> 16; m[total - 2] = lo >>> 8; m[total - 1] = lo;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Array(64);
    function r(x, k) { return (x >>> k) | (x << (32 - k)); }
    for (var o = 0; o < total; o += 64) {
      for (var t = 0; t < 16; t++) W[t] = (m[o + 4 * t] << 24) | (m[o + 4 * t + 1] << 16) | (m[o + 4 * t + 2] << 8) | m[o + 4 * t + 3];
      for (t = 16; t < 64; t++) {
        var s0 = r(W[t - 15], 7) ^ r(W[t - 15], 18) ^ (W[t - 15] >>> 3), s1 = r(W[t - 2], 17) ^ r(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
        var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ("00000000" + (x >>> 0).toString(16)).slice(-8); }).join("");
  }

  // ---------------------------------------------------------------- helpers
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  function eq(a, b) { return canonical(a) === canonical(b); }
  // Numbers exactly as written (acceptance test 2026-11-24): Python writes 0.0 and fingerprints it as "0.0", while
  // JSON.parse turns it into 0. For the checks that compare with a hash Python computed, the summary is re-read with
  // each number kept as its source text, and serialized canonically from that.
  function Num(t) { this.t = t; }
  function parseLex(text) {
    var i = 0, n = text.length;
    function ws() { while (i < n && " \t\n\r".indexOf(text[i]) >= 0) i++; }
    function str() { var j = i; i++; while (i < n && text[i] !== '"') { if (text[i] === "\\") i++; i++; } i++; return JSON.parse(text.slice(j, i)); }
    function val() {
      ws(); var c = text[i];
      if (c === "{") { i++; var o = {}; ws(); if (text[i] === "}") { i++; return o; }
        for (;;) { ws(); var k = str(); ws(); i++; o[k] = val(); ws(); if (text[i] === ",") { i++; continue; } i++; return o; } }
      if (c === "[") { i++; var a = []; ws(); if (text[i] === "]") { i++; return a; }
        for (;;) { a.push(val()); ws(); if (text[i] === ",") { i++; continue; } i++; return a; } }
      if (c === '"') return str();
      var m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
      if (!m) throw new Error("bad JSON");
      i += m[0].length;
      return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : new Num(m[0]);
    }
    var v = val(); return v;
  }
  function canonLex(v) {
    if (v instanceof Num) return v.t;
    if (Array.isArray(v)) return "[" + v.map(canonLex).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canonLex(v[k]); }).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  function workflowCanon(s) { return s.__lex && isObj(s.__lex) ? canonLex(s.__lex.workflow) : canonical(s.workflow); }
  function uniqSorted(xs) { var o = {}; xs.forEach(function (x) { o[x] = 1; }); return Object.keys(o).sort(); }
  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
  function utf8(text) { return new TextEncoder().encode(text); }
  function decode(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (e) { throw new Refused("the file is not UTF-8 text"); }
  }

  // ---------------------------------------------------------------- summarise (port of chain.summarise_chain)
  function summarise(recs, conds) {
    conds = conds || CONDITIONS;
    var dec = recs.filter(function (x) { return x.kind === "decision"; });
    var counts = {};
    conds.forEach(function (c) { counts[c] = {}; DIRECTIONS.forEach(function (d) { counts[c][d] = {}; OUTCOMES.forEach(function (o) { counts[c][d][o] = 0; }); }); });
    dec.forEach(function (x) {
      if (!counts[x.condition] || !counts[x.condition][x.direction] || !(x.outcome in counts[x.condition][x.direction]))
        throw new Refused("a decision record has an unknown condition, direction or outcome");
      counts[x.condition][x.direction][x.outcome] += 1;
    });
    var paired = {};
    conds.forEach(function (c) {
      var idx = {}, cases = {};
      dec.filter(function (x) { return x.condition === c; }).forEach(function (x) {
        var k = JSON.stringify([x.run_id, x.run, x.order]); idx[k + "|" + x.direction] = x; cases[k] = 1;
      });
      var both = Object.keys(cases).map(function (k) { return [idx[k + "|A"], idx[k + "|B"]]; }).filter(function (p) { return p[0] && p[1]; });
      var ok = ["MATCHED", "OPPOSITE", "UNCLEAR"];
      var readable = both.filter(function (p) { return ok.indexOf(p[0].outcome) >= 0 && ok.indexOf(p[1].outcome) >= 0; });
      paired[c] = { cases: both.length, readable_cases: readable.length,
        both_priorities_got_their_own_option: readable.filter(function (p) { return p[0].outcome === "MATCHED" && p[1].outcome === "MATCHED"; }).length };
    });
    var hand = recs.filter(function (x) { return x.kind === "handoff"; });
    return { calls_recorded: recs.length, decision_calls: dec.length, handoff_calls: hand.length,
      handoff_calls_missing: hand.filter(function (x) { return x.outcome === "MISSING"; }).length,
      providers: uniqSorted(recs.map(function (x) { return x.provider; })),
      models_requested: uniqSorted(recs.map(function (x) { return x.model_requested === null || x.model_requested === undefined ? "None" : String(x.model_requested); })),
      models_served: uniqSorted(recs.filter(function (x) { return x.model_served; }).map(function (x) { return x.model_served; })),
      runs: uniqSorted(recs.map(function (x) { return String(x.run); })).length,
      orders: uniqSorted(recs.map(function (x) { return x.order; })), counts: counts, paired: paired };
  }

  function identityMismatches(s, again) {
    var out = [];
    if (!eq(again.providers, [s.provider])) out.push("the summary's provider " + JSON.stringify(s.provider) + " is not the records' " + JSON.stringify(again.providers));
    if (!eq(again.models_requested, [s.model_requested === null ? "None" : String(s.model_requested)]))
      out.push("the summary's model_requested " + JSON.stringify(s.model_requested) + " is not the records' " + JSON.stringify(again.models_requested));
    if (!eq(again.models_served, s.models_served)) out.push("the summary's models_served is not the records'");
    if (s.summary_format === WF_FORMAT) {
      if (!isObj(s.workflow) || Boolean(s.fake_run) !== Boolean(s.workflow.fake) || !eq(again.providers, ["workflow:" + s.workflow.name]) ||
          s.workflow_fingerprint !== sha256(utf8(workflowCanon(s))))
        out.push("the summary's workflow description, fingerprint or fake/real label does not match its records");
    } else if (Boolean(s.fake_run) !== eq(again.providers, ["fake"])) out.push("the summary says fake_run=" + (s.fake_run ? "True" : "False") + " but the records come from provider(s) " + JSON.stringify(again.providers));
    return out;
  }

  // ---------------------------------------------------------------- record checks (port of compare.record_problems)
  var PYSPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  var STRIP = new RegExp("^[" + PYSPACE + "]+|[" + PYSPACE + "]+$", "g");
  var LINES = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;
  var STRICT = new RegExp("^FIRST CHOICE:[" + PYSPACE + "]*(A|B|UNCLEAR)$", "i");
  function pyStrip(t) { return t.replace(STRIP, ""); }
  function parseStrict(text) {
    if (typeof text !== "string" || !pyStrip(text)) return "INVALID";
    var m = STRICT.exec(pyStrip(pyStrip(text).split(LINES)[0]));
    return m ? m[1].toUpperCase() : "INVALID";
  }
  var SC_REQ = ["scenario_id", "question", "option_a", "option_b", "priority_A", "priority_B"];
  function scenarioSha(sc) {
    var o = {}, keys = Object.keys(sc);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = sc[k];
      if (SC_REQ.indexOf(k) < 0 && k !== "context") return null;
      if (typeof v !== "string" || !pyStrip(v) || v.length > 4000) return null;
      o[k] = pyStrip(v);
    }
    if (SC_REQ.some(function (k) { return !(k in o); }) || o.option_a === o.option_b || o.priority_A === o.priority_B) return null;
    return sha256(utf8(canonical(o)));
  }
  function between(t, a, b) {
    if (typeof t !== "string") return null;
    var i = t.indexOf(a); if (i < 0) return null;
    var j = t.indexOf(b, i + a.length); return j < 0 ? null : t.slice(i + a.length, j);
  }
  function scenarioCandidates(recs) {
    var sc = { scenario_id: recs.length ? recs[0].scenario_id : null }, task = null;
    recs.forEach(function (x) {
      var d = x.direction;
      if (x.target_option_text && (d === "A" || d === "B")) sc["option_" + d.toLowerCase()] = x.target_option_text;
      if (x.kind === "handoff" && x.handoff === 1 && x.chain_arm === "with_priority" && typeof x.prompt === "string") {
        if (!(("priority_" + d) in sc)) sc["priority_" + d] = between(x.prompt, "What they have told you matters to them:\n", "\n\nTheir situation:");
        if (x.order === "as_given" || task === null) task = between(x.prompt, "TASK: ", "\nOPTION A: ");
      }
    });
    if (task === null) return [];
    var out = [Object.assign({}, sc, { question: task })];
    for (var i = 0; i < task.length; i++) if (task[i] === "\n") out.push(Object.assign({}, sc, { question: task.slice(0, i), context: task.slice(i + 1) }));
    return out;
  }
  // ---------------------------------------------------------------- whole-workflow checks (port of workflow.ExposureTracker,
  // workflow.exposure_summary and compare.workflow_record_problems)
  var WF_OPTIONAL = ["direct", "restored"];
  function wnorm(t) { return String(t === null || t === undefined ? "" : t).trim().toLowerCase().replace(/\s+/g, " "); }
  function hasCycle(n, edges) {   // port of workflow._has_cycle
    var st = [], succ = [];
    for (var k = 0; k < n; k++) { st.push(0); succ.push([]); }
    edges.forEach(function (e) { succ[e[0]].push(e[1]); });
    function visit(k) { st[k] = 1; for (var q = 0; q < succ[k].length; q++) { var m = succ[k][q]; if (st[m] === 1 || (st[m] === 0 && visit(m))) return true; } st[k] = 2; return false; }
    for (var k2 = 0; k2 < n; k2++) if (st[k2] === 0 && visit(k2)) return true;
    return false;
  }
  function unesc(t) {             // rule 5: undo JSON-style escapes before matching (port of workflow._unesc)
    t = String(t === null || t === undefined ? "" : t);
    t = t.replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
    return t.split('\\"').join('"').split("\\n").join(" ").split("\\t").join(" ");
  }
  function nn(t, rule) { return (rule || 1) >= 5 ? wnorm(unesc(t)) : wnorm(t); }
  function stateStrings(st) {      // rule 4: every string value and key, unescaped (port of workflow._state_strings)
    var out = [];
    if (typeof st === "string") out.push(st);
    else if (Array.isArray(st)) st.forEach(function (v) { out = out.concat(stateStrings(v)); });
    else if (isObj(st)) Object.keys(st).forEach(function (k) { out.push(String(k)); out = out.concat(stateStrings(st[k])); });
    return out;
  }
  function agentTexts(a, rule) {
    var req = (Array.isArray(a.request_messages) ? a.request_messages : []).filter(function (m) { return isObj(m) && typeof m.content === "string"; }).map(function (m) { return m.content; });
    if (a.state_visible === null || a.state_visible === undefined) return { req: req, st: [] };
    return { req: req, st: (rule || 1) >= 4 ? stateStrings(a.state_visible) : [JSON.stringify(a.state_visible)] };
  }
  function literalExposure(trace, text, rule, outputs) {
    var out = [], n = wnorm(text);
    if (!n || !isObj(trace) || !Array.isArray(trace.agents)) return out;
    trace.agents.forEach(function (a) {
      if (!isObj(a)) return;
      var t = agentTexts(a, rule);
      if (t.req.some(function (x) { return nn(x, rule).indexOf(n) >= 0; })) out.push({ agent: a.id === undefined ? null : a.id, where: "model request" });
      else if (t.st.some(function (x) { return nn(x, rule).indexOf(n) >= 0; })) out.push({ agent: a.id === undefined ? null : a.id, where: "visible state only" });
      else if (outputs && nn(a.output, rule).indexOf(n) >= 0) out.push({ agent: a.id === undefined ? null : a.id, where: "output, not in its recorded input" });
    });
    return out;
  }
  // carryover rules 2 and 3 (2026-11-23; records with "exposure_rule": 2 or 3; rule 3 is rule 2 made order-aware): a NOVEL fragment of an earlier execution's output
  // (a 40+ character sentence absent from earlier executions' inputs and from the producing agent's own request, and not
  // scenario text) found in this execution's agent inputs outside the parts this execution accounts for (its own
  // outputs, reused workflow outputs in restored, the scenario's texts). Records without the field use rule 1.
  function fragments(text) {
    var n = wnorm(text);
    var fr = String(text === null || text === undefined ? "" : text).trim().toLowerCase().split(/(?<=[.!?])\s+|\n+/)
      .map(function (f) { return f.trim(); }).filter(function (f) { return f && f.length >= 40; })
      .map(function (f) { return f.replace(/\s+/g, " "); });
    return fr.length ? fr : (n.length >= 40 ? [n] : []);
  }
  function stripParts(text, parts) {
    var ps = parts.filter(function (x) { return x; }).sort(function (a, b) { return b.length - a.length; });
    var out = text; ps.forEach(function (p) { out = out.split(p).join("\u0000"); }); return out;
  }
  function ExposureTracker(sc) {
    this.pri = { A: sc.priority_A, B: sc.priority_B }; this.earlier = {}; this.wf = {}; this.novel = {}; this.inputsSeen = []; this.novelBy = {}; this.outBy = {}; this.carried = {};
    this.scen = ["question", "context", "option_a", "option_b", "priority_A", "priority_B"].filter(function (k) { return sc[k]; }).map(function (k) { return wnorm(sc[k]); });
  }
  ExposureTracker.prototype.check = function (rec) {
    var tr = rec.trace, cond = rec.condition, d = rec.direction, e, self = this;
    var rule = rec.exposure_rule === undefined ? 1 : rec.exposure_rule;
    var o5 = rule >= 5;
    if (cond === "workflow_no_priority") e = { priority_text_in_no_priority_execution: literalExposure(tr, this.pri.A, rule, o5).concat(literalExposure(tr, this.pri.B, rule, o5)) };
    else e = { given_priority_found: literalExposure(tr, this.pri[d], rule), opposite_priority_found: literalExposure(tr, this.pri[d === "A" ? "B" : "A"], rule, o5) };
    var agents = isObj(tr) && Array.isArray(tr.agents) ? tr.agents.filter(isObj) : [];
    var own = {}; agents.forEach(function (a) { own[wnorm(a.output)] = 1; });
    var key = JSON.stringify([rec.run, rec.order, d]);
    if (cond === "workflow") this.wf[key] = Object.assign({}, own);
    var reusable = Object.assign({}, own, cond === "restored" ? (this.wf[key] || {}) : {});
    var seen = [];
    if (rule === 1) {
      var earlier = this.earlier, cand = Object.keys(earlier).filter(function (t) { return !reusable[t]; });
      agents.forEach(function (a) {
        var t = agentTexts(a);
        if (cand.some(function (c) { return t.req.some(function (x) { return wnorm(x).indexOf(c) >= 0; }); })) seen.push({ agent: a.id === undefined ? null : a.id, where: "model request" });
        else if (cand.some(function (c) { return t.st.some(function (x) { return wnorm(x).indexOf(c) >= 0; }); })) seen.push({ agent: a.id === undefined ? null : a.id, where: "visible state only" });
      });
    } else if (rule >= 5) {
      // rule 5: rule 3 on inputs with escapes undone; trace order not relied on when visibly wrong; output check advisory
      var outs5 = agents.map(function (a) { return nn(a.output, rule); }), sc5 = this.scen, nov5 = Object.keys(this.novel), by5 = this.novelBy, T5 = this;
      // edges j -> i (agent i's request holds agent j's whole output); misordered only if a backward edge exists and some
      // order satisfies every edge (no cycle): a cycle means the text came from outside this execution (port of workflow.py)
      var edges = [];
      agents.forEach(function (a, i) { var rq = agentTexts(a, rule).req.map(function (x) { return nn(x, rule); });
        for (var j = 0; j < agents.length; j++) {
          if (j === i || outs5[j].length < 40) continue;
          var lim = Math.min(i, j), inEarlier = false;
          for (var k = 0; k < lim; k++) if (k !== j && outs5[k].indexOf(outs5[j]) >= 0) inEarlier = true;
          if (!inEarlier && rq.some(function (x) { return x.indexOf(outs5[j]) >= 0; })) edges.push([j, i]);
        } });
      var mis = edges.some(function (e2) { return e2[0] > e2[1]; }) && !hasCycle(agents.length, edges);
      var base5 = cond === "restored" ? Object.keys(this.wf[key] || {}) : [];
      var prior5 = mis ? base5.concat(outs5) : base5.slice(), unrec = [];
      agents.forEach(function (a, i) {
        var t = agentTexts(a, rule), ex5 = prior5.concat(sc5);
        var c5 = nov5.filter(function (f) { return !prior5.some(function (o) { return o.indexOf(f) >= 0; }); });
        var sreq = t.req.map(function (x) { return stripParts(nn(x, rule), ex5); }), sst = t.st.map(function (x) { return stripParts(nn(x, rule), ex5); });
        var hit = function (xs) { return c5.some(function (f) { return xs.some(function (x) { return x.indexOf(f) >= 0; }); }); };
        if (hit(sreq)) seen.push({ agent: a.id === undefined ? null : a.id, where: "model request" });
        else if (hit(sst)) seen.push({ agent: a.id === undefined ? null : a.id, where: "visible state only" });
        var rawIn = t.req.concat(t.st).map(function (x) { return nn(x, rule); }), mine5 = T5.outBy[a.id] || [];
        var outf = nov5.filter(function (f) {
          return outs5[i].indexOf(f) >= 0 && !(by5[f] && by5[f].indexOf(a.id) >= 0) &&
            stripParts(f, sc5).split("\u0000").join("").trim().length >= 40 && !mine5.some(function (o) { return o.indexOf(f) >= 0; }) &&
            !rawIn.some(function (x) { return x.indexOf(f) >= 0; }) && !prior5.some(function (o) { return o.indexOf(f) >= 0; });
        });
        if (outf.length) { unrec.push({ agent: a.id === undefined ? null : a.id, where: "output, not in its recorded input" });
          var cs = T5.carried[a.id] = T5.carried[a.id] || []; outf.forEach(function (f) { if (cs.indexOf(f) < 0) cs.push(f); }); }
        if (!mis) prior5.push(outs5[i]);
      });
      e.unrecorded_source_suspected = unrec;
      if (mis) e.trace_order_not_relied_on = true;
    } else if (rule === 4) {
      // rule 4: rule 3 on inputs (state as string values) plus outputs that carry another agent's earlier novel sentence
      var prior4 = cond === "restored" ? Object.keys(this.wf[key] || {}) : [], scen4 = this.scen, nov4 = Object.keys(this.novel), by4 = this.novelBy; var selfT = this;
      agents.forEach(function (a) {
        var t = agentTexts(a, rule), ex4 = prior4.concat(scen4);
        var c4 = nov4.filter(function (f) { return !prior4.some(function (o) { return o.indexOf(f) >= 0; }); });
        var sreq = t.req.map(function (x) { return stripParts(wnorm(x), ex4); }), sst = t.st.map(function (x) { return stripParts(wnorm(x), ex4); });
        var hit = function (xs) { return c4.some(function (f) { return xs.some(function (x) { return x.indexOf(f) >= 0; }); }); };
        if (hit(sreq)) seen.push({ agent: a.id === undefined ? null : a.id, where: "model request" });
        else if (hit(sst)) seen.push({ agent: a.id === undefined ? null : a.id, where: "visible state only" });
        else {
          var rawIn = t.req.concat(t.st).map(wnorm);
          var on4 = wnorm(a.output), mine4 = selfT.outBy[a.id] || [];
          var outf = nov4.filter(function (f) {
            return on4.indexOf(f) >= 0 && !(by4[f] && by4[f].indexOf(a.id) >= 0) &&
              stripParts(f, scen4).split("\u0000").join("").trim().length >= 40 && !mine4.some(function (o) { return o.indexOf(f) >= 0; }) &&
              !rawIn.some(function (x) { return x.indexOf(f) >= 0; }) && !prior4.some(function (o) { return o.indexOf(f) >= 0; });
          });
          if (outf.length) seen.push({ agent: a.id === undefined ? null : a.id, where: "output, not in its recorded input" });
        }
        prior4.push(wnorm(a.output));
      });
    } else if (rule === 3) {
      // rule 3 (order-aware): only outputs of agents that ran BEFORE this one (plus reused workflow outputs in restored)
      var prior = cond === "restored" ? Object.keys(this.wf[key] || {}) : [], scen3 = this.scen, nov = Object.keys(this.novel);
      agents.forEach(function (a) {
        var t = agentTexts(a), ex3 = prior.concat(scen3);
        var c3 = nov.filter(function (f) { return !prior.some(function (o) { return o.indexOf(f) >= 0; }); });
        var hit = function (xs) { return c3.some(function (f) { return xs.some(function (x) { return stripParts(wnorm(x), ex3).indexOf(f) >= 0; }); }); };
        if (hit(t.req)) seen.push({ agent: a.id === undefined ? null : a.id, where: "model request" });
        else if (hit(t.st)) seen.push({ agent: a.id === undefined ? null : a.id, where: "visible state only" });
        prior.push(wnorm(a.output));
      });
    } else {
      var reus = Object.keys(reusable), explained = reus.concat(this.scen);
      var cand2 = Object.keys(this.novel).filter(function (f) { return !reus.some(function (o) { return o.indexOf(f) >= 0; }); });
      agents.forEach(function (a) {
        var t = agentTexts(a);
        var hit = function (xs) { return cand2.some(function (f) { return xs.some(function (x) { return stripParts(wnorm(x), explained).indexOf(f) >= 0; }); }); };
        if (hit(t.req)) seen.push({ agent: a.id === undefined ? null : a.id, where: "model request" });
        else if (hit(t.st)) seen.push({ agent: a.id === undefined ? null : a.id, where: "visible state only" });
      });
    }
    e.earlier_execution_output_found = seen;
    Object.keys(own).forEach(function (o) { if (o.length >= 40) self.earlier[o] = 1; });
    var u = rule >= 5 ? unesc : function (t) { return t; };
    agents.forEach(function (a) {
      var mine = agentTexts(a).req.map(function (x) { return wnorm(u(x)); }), all = self.inputsSeen.concat(mine);
      fragments(u(a.output)).forEach(function (f) {
        if (!all.some(function (x) { return x.indexOf(f) >= 0; }) && !self.scen.some(function (x) { return x.indexOf(f) >= 0; })) self.novel[f] = 1;
        if (self.novel[f] && !(rule >= 5 && (self.carried[a.id] || []).indexOf(f) >= 0)) { var ids = self.novelBy[f] = self.novelBy[f] || []; if (ids.indexOf(a.id) < 0) ids.push(a.id); }
      });
    });
    agents.forEach(function (a) { agentTexts(a).req.forEach(function (x) { self.inputsSeen.push(wnorm(u(x))); }); });
    agents.forEach(function (a) { if (!(rule >= 5 && (self.carried[a.id] || []).length)) (self.outBy[a.id] = self.outBy[a.id] || []).push(wnorm(u(a.output))); });
    return e;
  };
  function exposureSummary(recs) {
    var ex = recs.filter(function (x) { return x.kind === "execution" && isObj(x.exposure) && Object.keys(x.exposure).length; });
    var allex = recs.filter(function (x) { return x.kind === "execution"; });
    var traced = allex.filter(function (x) { return isObj(x.trace); });
    var by = {};
    ex.forEach(function (x) {
      if (x.condition !== "workflow") return;
      (x.exposure.given_priority_found || []).forEach(function (f) { var k = by[f.agent] = by[f.agent] || { "model request": 0, "visible state only": 0 }; k[f.where] += 1; });
    });
    var nz = function (k) { return ex.filter(function (x) { return (x.exposure[k] || []).length; }).length; };
    var nfc = 0; traced.forEach(function (x) { (x.trace.agents || []).forEach(function (a) { if (isObj(a) && !a.request_complete) nfc++; }); });
    var res = { no_priority_executions_with_priority_text: nz("priority_text_in_no_priority_execution"),
      executions_without_served_model: allex.filter(function (x) { return !x.model_served && !x.error; }).length,
      executions_with_earlier_execution_output: nz("earlier_execution_output_found"),
      workflow_priority_found_by_agent: by, priority_executions_with_opposite_priority_text: nz("opposite_priority_found"),
      executions_with_trace: traced.length, executions_without_trace: allex.length - traced.length, agent_requests_not_fully_captured: nfc,
      note: "Literal checks: the text being present shows exposure; its absence does not show the information was absent (it may be paraphrased, or the instrumentation may not capture it)." };
    if (ex.some(function (x) { return (x.exposure_rule || 1) >= 5; })) {      // keys of rule-5 runs only (older summaries keep verifying)
      var out5 = {}; Object.keys(res).forEach(function (k) { if (k !== "note") out5[k] = res[k]; });
      out5.executions_with_unrecorded_source_suspected = nz("unrecorded_source_suspected");
      out5.executions_with_trace_out_of_order = ex.filter(function (x) { return x.exposure.trace_order_not_relied_on; }).length;
      out5.note = res.note; return out5;
    }
    return res;
  }
  function workflowRecordProblems(recs, s, sc) {
    var out = [], conds = s.conditions || [], ns = s.not_supported || [], sup = (isObj(s.workflow) && isObj(s.workflow.supports)) ? s.workflow.supports : {};
    var expectNs = WF_OPTIONAL.filter(function (c) { return conds.indexOf(c) < 0; });
    if (conds.some(function (c) { return ns.indexOf(c) >= 0; }) || !eq(ns.slice().sort(), expectNs.slice().sort()) ||
        WF_OPTIONAL.some(function (c) { return Boolean(sup[c]) !== (conds.indexOf(c) >= 0); }))
      out.push("the summary's conditions, NOT SUPPORTED list and the adapter's supports do not agree");
    if (recs.some(function (x) { return conds.indexOf(x.condition) < 0; })) out.push("records contain a condition the summary does not list (e.g. one marked NOT SUPPORTED)");
    var ex = recs.filter(function (x) { return x.kind === "execution"; });
    if (ex.some(function (x) { return !eq((x.request || {}).config === undefined ? null : x.request.config, s.config === undefined ? null : s.config); }))
      out.push("the summary's configuration is not the configuration recorded in its executions' requests");
    if (sc) {
      var pri = { A: sc.priority_A, B: sc.priority_B };
      for (var i = 0; i < ex.length; i++) {
        var q = ex[i].request || {}, want = ex[i].condition === "workflow_no_priority" ? null : (pri[ex[i].direction] === undefined ? null : pri[ex[i].direction]);
        if ((q.priority === undefined ? null : q.priority) !== want || q.condition !== ex[i].condition || q.order !== ex[i].order) {
          out.push("an execution's recorded request does not match its condition (priority, order or condition)"); break;
        }
      }
      var tk = new ExposureTracker(sc);
      for (i = 0; i < ex.length; i++) {
        var r = ex[i];
        if (!r.exposure_checked) { if (isObj(r.exposure) && Object.keys(r.exposure).length) { out.push("an execution carries exposure results although none were computed for it"); break; } continue; }
        if (!eq(tk.check(r), r.exposure)) { out.push("a recorded exposure check does not match its own trace (execution " + r.execution_id + ")"); break; }
      }
      if (!eq(exposureSummary(recs), s.exposure_checks)) out.push("the summary's exposure checks are not those of its own records");
    }
    return out;
  }

  function recordProblems(recs, s) {
    var out = [];
    for (var i = 0; i < recs.length; i++) {
      var x = recs[i];
      if (x.kind !== "decision") continue;
      var ok = (x.error === null || x.error === undefined) && typeof x.response_text === "string";
      if (!ok) { if (x.outcome !== "MISSING") out.push("a failed call is scored " + x.outcome + ", not MISSING (record " + x.condition + "/" + x.direction + ")"); continue; }
      var letter = parseStrict(x.response_text), shown = { A: x.option_a_shown, B: x.option_b_shown };
      var want = letter === "INVALID" ? "INVALID" : letter === "UNCLEAR" ? "UNCLEAR" : shown[letter] === x.target_option_text ? "MATCHED" : "OPPOSITE";
      if (letter !== x.parsed || want !== x.outcome || ((letter === "A" || letter === "B") && x.chosen_option_text !== shown[letter])) {
        out.push("a recorded answer does not give its recorded outcome when re-read (" + x.condition + ", priority favours " + x.direction + ", run " + x.run + ", " + x.order + "): the answer reads " + letter + ", the record says " + x.outcome);
        break;
      }
    }
    var wfs = s.summary_format === WF_FORMAT;
    if (wfs) {
      var sc = s.scenario, tgt = isObj(sc) ? { A: sc.option_a, B: sc.option_b } : {};
      var okSc = isObj(sc) && scenarioSha(sc) === s.scenario_sha256 && !recs.some(function (x) {
        return x.kind === "decision" && (x.target_option_text !== tgt[x.direction] || uniqSorted([x.option_a_shown, x.option_b_shown]).join("\u0000") !== uniqSorted([tgt.A, tgt.B]).join("\u0000"));
      });
      out = out.concat(workflowRecordProblems(recs, s, okSc ? sc : null));
      if (!okSc) out.push("scenario_sha256 does not match the scenario text in the records (the summary's scenario hash was changed, or the records belong to another scenario)");
    }
    var shas = wfs ? [] : scenarioCandidates(recs).map(scenarioSha);
    if (!wfs && shas.indexOf(s.scenario_sha256) < 0) out.push("scenario_sha256 does not match the scenario text in the records (the summary's scenario hash was changed, or the records belong to another scenario)");
    var keys = {};
    for (i = 0; i < recs.length; i++) {
      x = recs[i];
      var k = JSON.stringify([x.kind, x.run, x.order, x.direction, x.kind === "handoff" ? x.chain_arm : x.condition, x.handoff === undefined ? null : x.handoff]);
      if (keys[k]) { out.push("a call appears twice in the records (" + x.kind + ", run " + x.run + ", " + x.order + ", priority favours " + x.direction + "): duplicated records are not repeats"); break; }
      keys[k] = 1;
    }
    var runs = s.runs_requested || 0;
    if (recs.some(function (x) { return typeof x.run !== "number" || x.run % 1 !== 0 || x.run < 0 || x.run >= runs; })) out.push("a record's run number is outside the " + s.runs_requested + " run(s) requested");
    if (recs.some(function (x) { return (s.orders_requested || []).indexOf(x.order) < 0; })) out.push("a record's option order was not requested");
    if (uniqSorted(recs.map(function (x) { return String(x.run_id); })).length !== 1 || (recs.length && recs[0].run_id !== s.run_id)) out.push("the records do not all carry the summary's run id");
    var starts = recs.filter(function (x) { return x.t_start !== null && x.t_start !== undefined; }).map(function (x) { return x.t_start; });
    if (starts.some(function (t) { return typeof t !== "string"; }) || starts.some(function (t, j) { return j > 0 && t < starts[j - 1]; }))
      out.push("call start times go backwards in the records (records were reordered, copied or appended)");
    if (!s.fake_run && !wfs && recs.some(function (x) { return x.t_start !== null && x.t_start !== undefined && !(isObj(x.exchange) && isObj(x.exchange.request_body) && "response" in x.exchange); }))
      out.push("a real run's record lacks the exact request and raw response the kit stores for every call made");
    if (!s.fake_run && !wfs) {
      var ids = recs.filter(function (x) { return x.t_start !== null && x.t_start !== undefined && isObj(x.exchange) && isObj(x.exchange.response); })
        .map(function (x) { return x.exchange.response.id || x.exchange.response.responseId; }).filter(function (i) { return i; });
      if (uniqSorted(ids.map(String)).length !== ids.length) out.push("two calls carry the same provider response id: records were copied, not made by separate calls");
    }
    return out;
  }

  function parseJsonl(text) {
    var out = [];
    text.split("\n").forEach(function (line, i) {
      if (!line.trim()) return;
      var x;
      try { x = JSON.parse(line); } catch (e) { throw new Refused("records line " + (i + 1) + " is not valid JSON"); }
      if (!isObj(x)) throw new Refused("records line " + (i + 1) + " is not a JSON object");
      out.push(x);
    });
    return out;
  }

  // ---------------------------------------------------------------- load and verify a run
  // input: {summaryText} or {summaryText, recordsBytes} or {bundleText}. Returns {summary, records|null, records_verified,
  // recordsText|null, source}. Throws Refused with a plain-language reason.
  function loadRun(input) {
    var summaryText = input.summaryText, recordsBytes = input.recordsBytes || null, source = input.source || "run";
    if (input.bundleText !== undefined) {
      var b = parseObj(input.bundleText, "the saved result");
      var extra = Object.keys(b).filter(function (k) { return ["format", "saved_note", "summary", "records_jsonl"].indexOf(k) < 0; });
      if (b.format !== BUNDLE_FORMAT) throw new Refused("not a saved result (format must be " + BUNDLE_FORMAT + ")");
      if (extra.length) throw new Refused("the saved result has unknown field(s): " + extra.join(", "));
      if (!isObj(b.summary)) throw new Refused("the saved result has no summary");
      if (b.records_jsonl !== null && typeof b.records_jsonl !== "string") throw new Refused("the saved result's records must be text");
      try { summaryText = canonLex(parseLex(input.bundleText).summary); } catch (e) { summaryText = JSON.stringify(b.summary); }
      recordsBytes = b.records_jsonl === null ? null : utf8(b.records_jsonl);
    }
    var s = parseObj(summaryText, "summary.json");
    try { Object.defineProperty(s, "__lex", { value: parseLex(summaryText), enumerable: false }); } catch (e) { /* plain check */ }
    var missing = REQUIRED_FIELDS.filter(function (k) { return !(k in s); });
    if (missing.length) throw new Refused("summary.json lacks " + missing.join(", ") + ": not a chain summary, or written by an older kit; re-run `chain`");
    if (!isObj(s.counts) || !isObj(s.paired)) throw new Refused("summary.json counts are malformed");
    var sp = summaryProblems(s);
    if (sp.length) throw new Refused("summary.json: " + sp[0]);
    var verified = false, records = null, recordsText = null;
    if (recordsBytes) {
      if (recordsBytes.length > MAX_BYTES) throw new Refused("records.jsonl is larger than 20 MB");
      var got = sha256(recordsBytes);
      if (got !== s.records_sha256) throw new Refused("records.jsonl: sha256 " + got + " does not match the summary's records_sha256 " + s.records_sha256 + " (the records were changed after the run, or the summary belongs to another run)");
      recordsText = decode(recordsBytes);
      records = parseJsonl(recordsText);
      var wf = s.summary_format === WF_FORMAT;
      if (wf && (!Array.isArray(s.conditions) || !s.conditions.length || s.conditions.some(function (c) { return WF_CONDITIONS.indexOf(c) < 0; })))
        throw new Refused("summary.json lists unknown workflow conditions");
      var again = summarise(records, wf ? s.conditions : CONDITIONS);
      ["counts", "paired", "calls_recorded"].forEach(function (k) {
        if (!eq(again[k], s[k])) throw new Refused("the summary's '" + k + "' does not match its own records.jsonl (the summary was edited)");
      });
      var mm = identityMismatches(s, again).concat(recordProblems(records, s));
      if (mm.length) throw new Refused("summary.json: " + mm[0]);
      verified = true;
    }
    return { summary: s, records: records, recordsText: recordsText, records_verified: verified, source: source,
      records_times_sha256: verified ? sha256(utf8(canonical(records.map(function (x) { return x.t_start === undefined ? null : x.t_start; })))) : null };
  }
  function summaryProblems(s) {
    var per = (s.runs_requested || 0) * ((s.orders_requested || []).length), bad = null;
    try {
      Object.keys(s.counts).forEach(function (cond) {
        Object.keys(s.counts[cond]).forEach(function (d) {
          var k = s.counts[cond][d], n = 0, odd = false;
          Object.keys(k).forEach(function (o) { var v = k[o]; if (typeof v !== "number" || v % 1 !== 0 || v < 0) odd = true; n += v; });
          if (!bad && (odd || n > per || (n !== per && !s.incomplete)))
            bad = "the summary's counts are impossible: " + cond + "/" + d + " holds " + n + " decisions, but " + s.runs_requested + " run(s) x " + (s.orders_requested || []).length + " order(s) give " + per;
        });
      });
      if (!bad) Object.keys(s.paired).forEach(function (cond) {
        var p = s.paired[cond];
        if (!bad && !(0 <= p.both_priorities_got_their_own_option && p.both_priorities_got_their_own_option <= p.readable_cases && p.readable_cases <= p.cases && p.cases <= per))
          bad = "the summary's paired counts are impossible for " + cond;
      });
    } catch (e) { bad = "the summary's counts are malformed"; }
    return bad ? [bad] : [];
  }
  function parseObj(text, what) {
    if (typeof text !== "string") throw new Refused(what + " is missing");
    if (text.length > MAX_BYTES) throw new Refused(what + " is larger than 20 MB");
    var o;
    try { o = JSON.parse(text); } catch (e) { throw new Refused(what + " is not valid JSON"); }
    if (!isObj(o)) throw new Refused(what + " is not a JSON object");
    return o;
  }

  function bundleText(run, savedAt) {     // the saved file, with the summary's numbers exactly as they were read
    var b = bundle(run, savedAt), mark = "\u0000APA-SUMMARY\u0000";
    if (!run.summary.__lex) return JSON.stringify(b, null, 1) + "\n";
    b.summary = mark;
    return JSON.stringify(b, null, 1).replace(JSON.stringify(mark), canonLex(run.summary.__lex)) + "\n";
  }
  function bundle(run, savedAt) {
    return { format: BUNDLE_FORMAT,
      saved_note: "Saved from the Anchor-Preservation Auditor page" + (savedAt ? " on " + savedAt : "") + ". The summary and records are the priority_check output, unchanged; records_sha256 is re-checked when this file is opened." +
        (run.summary.fake_run ? " FAKE MODEL OUTPUT IS NOT EVIDENCE." : ""),
      summary: run.summary, records_jsonl: run.recordsText };
  }

  // ---------------------------------------------------------------- compare (port of compare.compare, without rules)
  function dictDiffs(field, a, b) {
    if (isObj(a) && isObj(b)) {
      return uniqSorted(Object.keys(a).concat(Object.keys(b))).filter(function (k) {
        return !eq(k in a ? a[k] : "<absent>", k in b ? b[k] : "<absent>");
      }).map(function (k) { return { field: field + "." + k, baseline: k in a ? a[k] : "<absent>", candidate: k in b ? b[k] : "<absent>" }; });
    }
    return [{ field: field, baseline: a, candidate: b }];
  }
  function differences(b, c) {
    var diffs = [];
    FIELDS.forEach(function (f) {
      var va = f[0] in b ? b[f[0]] : null, vb = f[0] in c ? c[f[0]] : null;
      if (f[0] === "settings" && (va === null || vb === null)) {
        diffs.push({ field: "settings", baseline: va, candidate: vb, "class": INVALID, message: "settings were not recorded for at least one run, so they cannot be checked" });
        return;
      }
      if (!eq(va, vb)) dictDiffs(f[0], va, vb).forEach(function (d) { d.message = f[1] + " not the same in both runs"; d["class"] = f[2]; diffs.push(d); });
    });
    if (b.fake_run !== c.fake_run) diffs[0].message = "a fake run and a real run are never comparable";
    [["baseline", b], ["candidate", c]].forEach(function (p) {
      var s = p[1];
      if (s.incomplete || s.calls_recorded !== s.planned_calls)
        diffs.push({ field: p[0] + ".complete", baseline: null, candidate: null, "class": INVALID,
          message: p[0] + " run is incomplete (" + (s.calls_recorded || 0) + " of " + (s.planned_calls || 0) + " planned calls recorded" + (s.incomplete ? "; " + s.incomplete : "") + ")" });
    });
    [["baseline", b], ["candidate", c]].forEach(function (p) {
      var e = p[1].exposure_checks || {};
      if (e.no_priority_executions_with_priority_text || e.priority_executions_with_opposite_priority_text || e.executions_with_earlier_execution_output)
        diffs.push({ field: p[0] + ".exposure_checks", baseline: null, candidate: null, "class": INVALID,
          message: p[0] + " run: text was found where it should not be (" + (e.no_priority_executions_with_priority_text || 0) + " no-priority execution(s) with a priority, " +
            (e.priority_executions_with_opposite_priority_text || 0) + " with the opposite priority, " + (e.executions_with_earlier_execution_output || 0) +
            " with an earlier execution's output): executions were not independent or the control was contaminated" });
    });
    if (b.run_id && b.run_id === c.run_id && b.records_sha256 !== c.records_sha256)
      diffs.push({ field: "run_id", baseline: b.run_id, candidate: c.run_id, "class": INVALID,
        message: "both runs carry the same run id but different records: at least one was edited or relabelled" });
    if (b.records_sha256 === c.records_sha256)
      diffs.push({ field: "records_sha256", baseline: b.records_sha256, candidate: c.records_sha256, "class": INVALID,
        message: "both sides are the same run (identical records): a repeatability check needs two separate runs" });
    return diffs;
  }
  function classify(diffs) {
    return diffs.some(function (d) { return d["class"] === INVALID; }) ? INVALID : diffs.length ? CHANGED : SAME;
  }
  function top(field) { return field.split(".")[0]; }
  function headline(verdict, diffs, wfp) {
    if (verdict === SAME) return "Same configuration: no recorded difference. Suitable for looking at repeatability and run-to-run variation.";
    if (verdict === INVALID) return "Not a valid controlled comparison: " + diffs.filter(function (d) { return d["class"] === INVALID; }).map(function (d) { return d.message; }).join("; ") + ".";
    var mf = MODEL_FIELDS.filter(function (f) { return !(wfp && f === "provider"); });
    var model = diffs.filter(function (d) { return mf.indexOf(top(d.field)) >= 0; });
    var other = diffs.filter(function (d) { return mf.indexOf(top(d.field)) < 0; });
    if (model.length) {
      return other.length ? "Model changed, with the following accompanying configuration differences: " + other.map(function (d) { return d.field; }).join(", ") + "."
        : "Model changed. No other recorded configuration difference was detected (unrecorded factors, such as provider-side changes behind the same settings, cannot be ruled out).";
    }
    return "Configuration changed: " + diffs.map(function (d) { return d.field; }).join(", ") + ".";
  }
  function repetitions(s) {
    var dec = [], use = [], one = 0, cells = 0;
    Object.keys(s.counts).forEach(function (c) {
      Object.keys(s.counts[c]).forEach(function (d) {
        var k = s.counts[c][d], tot = 0, u = 0;
        var mx = 0;
        Object.keys(k).forEach(function (o) { tot += k[o]; if (o !== "MISSING") u += k[o]; if (k[o] > mx) mx = k[o]; });
        dec.push(tot); use.push(u);
        if (tot) { cells++; if (mx === tot) one++; }
      });
    });
    return { scenarios: 1, runs_requested: s.runs_requested, runs_recorded: s.runs, orders: s.orders_requested,
      decisions_per_condition_and_direction: dec.length ? Math.max.apply(null, dec) : 0,
      fewest_usable_decisions_in_a_cell: use.length ? Math.min.apply(null, use) : 0,
      cells_where_every_repetition_gave_the_same_outcome: one, cells: cells };
  }
  function compare(baseline, candidate) {
    var b = baseline.summary, c = candidate.summary;
    var diffs = differences(b, c);
    if (baseline.records_times_sha256 && baseline.records_times_sha256 === candidate.records_times_sha256 && b.records_sha256 !== c.records_sha256)
      diffs.push({ field: "records.t_start", baseline: null, candidate: null, "class": INVALID,
        message: "both runs have identical call times: one is a relabelled copy of the other, not a separate run" });
    [["baseline", baseline], ["candidate", candidate]].forEach(function (p) {
      if (!p[1].records_verified) diffs.push({ field: p[0] + ".records", baseline: null, candidate: null, "class": INVALID,
        message: p[0] + ": only a summary was given, so its counts could not be checked against its records (give the run folder or a saved result)" });
    });
    var verdict = classify(diffs), valid = verdict !== INVALID;
    var conds = (b.conditions || CONDITIONS).filter(function (x) { return x in b.counts && x in c.counts; });
    var counts = [], paired = [];
    conds.forEach(function (cond) {
      DIRECTIONS.forEach(function (d) {
        var kb = b.counts[cond][d], kc = c.counts[cond][d], e = { condition: cond, direction: d, baseline: {}, candidate: {}, change: {} };
        OUTCOMES.forEach(function (o) { e.baseline[o] = kb[o]; e.candidate[o] = kc[o]; e.change[o] = kc[o] - kb[o]; });
        counts.push(e);
      });
      var pb = b.paired[cond], pc = c.paired[cond], keys = ["cases", "readable_cases", "both_priorities_got_their_own_option"];
      var x = { condition: cond, baseline: {}, candidate: {}, change: {} };
      keys.forEach(function (k) { x.baseline[k] = pb[k]; x.candidate[k] = pc[k]; x.change[k] = pc[k] - pb[k]; });
      paired.push(x);
    });
    var reps = { baseline: repetitions(b), candidate: repetitions(c) };
    var notes = ["Descriptive counts only. No statistical test is run and no significance is claimed. The kit has no " +
      "pass/fail threshold; any rule shown is the developer's own, set in advance.",
      "UNCLEAR, INVALID and MISSING are kept separate and never counted as OPPOSITE.",
      "All decisions come from one scenario: repeated runs and the two option orders are repeated samples of the " +
      "same scenario, not additional independent scenarios. Nothing here generalises to other decisions.",
      (b.summary_format === WF_FORMAT && c.summary_format === WF_FORMAT ? "Both runs tested the workflow your adapter ran, as the adapter describes it (whole-workflow test)." :
       b.summary_format !== WF_FORMAT && c.summary_format !== WF_FORMAT ? "Both runs tested the kit's FIXED six-handoff reference workflow, not your own agents." :
       "One run tested the kit's fixed reference workflow and the other a workflow through an adapter.")];
    if (Math.min(b.runs_requested || 1, c.runs_requested || 1) === 1)
      notes.unshift(REPEAT_WARNING + " One run per case on at least one side: the same prompt can give a different " +
        "answer when called again, so even an unchanged system can show changes. Use --runs 2 or more on both.");
    var groups = uniqSorted(diffs.map(function (d) { return MODEL_FIELDS.indexOf(top(d.field)) >= 0 ? "model" : top(d.field); }));
    if (verdict === CHANGED && groups.length > 1)
      notes.push("More than one thing changed, so no single change (including the model) can be credited with any difference in the counts.");
    if (b.runs_requested !== c.runs_requested)
      notes.push("The two sides have different numbers of repetitions: compare each count with its own total, not raw counts.");
    var adv = [["baseline", b], ["candidate", c]].map(function (x) { return [x[0], ((x[1].exposure_checks || {}).executions_with_unrecorded_source_suspected) || 0]; });
    if (adv.some(function (x) { return x[1]; }))
      notes.push("ADVISORY (does not invalidate): possible unrecorded source of earlier-execution text (" + adv.filter(function (x) { return x[1]; }).map(function (x) { return x[0] + ": " + x[1] + " execution(s)"; }).join(", ") +
        "): an unrecorded memory, cache or session history, or legitimately shared text. Check those agents' traces before relying on this comparison.");
    if (b.fake_run || c.fake_run)
      notes.push("FAKE MODEL OUTPUT IS NOT EVIDENCE: at least one run used fake (offline) models; its numbers say nothing about any real model.");
    var eb = (b.exposure_checks || {}).workflow_priority_found_by_agent, ecx = (c.exposure_checks || {}).workflow_priority_found_by_agent;
    if (eb && ecx && !eq(eb, ecx)) {
      var z = { "model request": 0, "visible state only": 0 };
      notes.push("Per-agent exposure changed (where the given priority's exact text was found, whole-workflow executions): " +
        uniqSorted(Object.keys(eb).concat(Object.keys(ecx))).filter(function (k) { return !eq(eb[k] || z, ecx[k] || z); }).map(function (k) {
          var x = eb[k] || z, y = ecx[k] || z;
          return k + ": in its request " + x["model request"] + " -> " + y["model request"] + ", only in state " + x["visible state only"] + " -> " + y["visible state only"];
        }).join("; ") + ". Exact text only: a paraphrase is not counted.");
    }
    [["baseline", baseline], ["candidate", candidate]].forEach(function (p) {
      if (!p[1].records_verified) notes.push(p[0] + ": a summary file was given, not its run directory, so its records.jsonl was not checked against it.");
    });
    if (b.kit_version !== c.kit_version)
      notes.push("Kit versions differ (" + b.kit_version + " vs " + c.kit_version + "). The prompt templates are checked by sha256; a change to the answer parser would not be detected.");
    if (!valid) notes.push("NOT A VALID CONTROLLED COMPARISON: the side-by-side counts are descriptive only. Changes may come from the listed differences, not from the change you meant to test.");
    var wfp = b.summary_format === WF_FORMAT && c.summary_format === WF_FORMAT;
    return { format: COMPARE_FORMAT, verdict: verdict, verdict_label: VERDICT_LABELS[verdict], headline: headline(verdict, diffs, wfp),
      model_changed: diffs.some(function (d) { return MODEL_FIELDS.indexOf(top(d.field)) >= 0 && !(wfp && top(d.field) === "provider"); }), repetitions: reps,
      differences: diffs, counts: counts, paired: paired, notes: notes };
  }

  return { bundleText: bundleText, BUNDLE_FORMAT: BUNDLE_FORMAT, WF_FORMAT: WF_FORMAT, WF_CONDITIONS: WF_CONDITIONS, CONDITIONS: CONDITIONS, DIRECTIONS: DIRECTIONS, OUTCOMES: OUTCOMES, FIELDS: FIELDS,
    MODEL_FIELDS: MODEL_FIELDS, SAME: SAME, CHANGED: CHANGED, INVALID: INVALID, VERDICT_LABELS: VERDICT_LABELS,
    REPEAT_WARNING: REPEAT_WARNING, REQUIRED_FIELDS: REQUIRED_FIELDS, Refused: Refused,
    sha256: sha256, canonical: canonical, parseStrict: parseStrict, recordProblems: recordProblems, summarise: summarise, parseJsonl: parseJsonl, loadRun: loadRun, bundle: bundle,
    differences: differences, classify: classify, compare: compare, utf8: utf8 };
});
