// Study 4 results page: shows window.STUDY4_RESULTS only after recomputing, in the browser, the decision rows' hash,
// every row's outcome, the outcome counts, the pair classes and the sensitive-unit counts, and finding them equal to
// the file's analysis. Any difference: nothing is shown but the error. No network, no storage; textContent only.
// (The bootstrap intervals are recomputed by release/tools/study4_results.py verify, which the release gate runs.)
(function () {
  "use strict";
  var D = window.STUDY4_RESULTS, R = window.APARunCompare;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function add(p) { var last = p; for (var i = 1; i < arguments.length; i++) if (arguments[i]) last = p.appendChild(arguments[i]); return last; }
  var LABEL = { direct: "Direct", delegated: "Delegated", restored: "Restated (restored)", t1_decision: "T1 decision (exploratory)" };
  var OUT = ["matched", "opposite", "unclear", "invalid", "missing"];
  var PAIRS = ["sensitive", "both_opposite", "same_option", "abstained", "invalid", "missing"];

  function banner(cls, title, text) {
    var b = h("div", "s4-banner " + cls); add(b, h("b", null, title)); add(b, h("span", null, text));
    $("s4-status").replaceChildren(b);
  }
  if (!D) {
    banner("s4-none", "Not yet available", "Study 4 has not run. Results will appear here only after the authorized run is unsealed and every number has been recomputed from its records.");
    return;
  }
  var fake = D.mode === "FAKE";
  function tag(t) { return (fake ? "FAKE · " : "") + t; }

  // ------------------------------------------------------------ recompute from the decision rows
  function outcome(strict, target) {
    if (!target) return { null: "missing", A: "chose_A", B: "chose_B", UNCLEAR: "unclear", INVALID: "invalid" }[strict === undefined ? null : strict];
    if (strict === null || strict === undefined) return "missing";
    if (strict === "A" || strict === "B") return strict === target ? "matched" : "opposite";
    return { UNCLEAR: "unclear", INVALID: "invalid" }[strict];
  }
  function pairClass(a, b) {
    var s = [a, b];
    if (s.indexOf("missing") >= 0) return "missing";
    if (s.indexOf("invalid") >= 0) return "invalid";
    if (s.indexOf("unclear") >= 0) return "abstained";
    if (a === "matched" && b === "matched") return "sensitive";
    if (a === "opposite" && b === "opposite") return "both_opposite";
    return "same_option";
  }
  function recompute() {
    var probs = [], rows = D.decisions || [], main = (D.report || {}).main || {};
    if (!R || R.sha256(R.utf8(R.canonical(rows))) !== D.decisions_sha256) probs.push("the decision rows do not match their recorded sha256");
    rows.forEach(function (r) { if (outcome(r.strict, r.target) !== r.outcome) probs.push("row " + r.uid + ": its outcome does not follow from its answer"); });
    var counts = {}, pairs = {}, sens = {};
    (main.conditions || []).forEach(function (k) {
      var c = {}; OUT.forEach(function (o) { c[o] = 0; });
      var units = {};
      rows.filter(function (r) { return r.condition === k; }).forEach(function (r) {
        c[r.outcome] += 1;
        var key = r.scenario + "|" + r.order + "|" + (r.chain === null ? 0 : r.chain);
        (units[key] = units[key] || []).push(r);
      });
      counts[k] = c;
      var p = {}; PAIRS.forEach(function (x) { p[x] = 0; });
      var kk = 0, nn = 0;
      Object.keys(units).forEach(function (key) {
        var us = units[key].slice().sort(function (a, b) { return a.case_id < b.case_id ? -1 : 1; });
        if (us.length !== 2) { probs.push("unit " + key + " does not have exactly two decisions"); return; }
        var cls = pairClass(us[0].outcome, us[1].outcome); p[cls] += 1;
        if (cls !== "missing") { nn++; if (cls === "sensitive") kk++; }
      });
      pairs[k] = p; sens[k] = { k: kk, n: nn };
      if (!R.canonical || R.canonical(c) !== R.canonical(main.outcome_counts[k])) probs.push(k + ": outcome counts differ from the file's analysis");
      if (R.canonical(p) !== R.canonical(main.pair_class_counts[k])) probs.push(k + ": pair classes differ from the file's analysis");
      var ms = main.sensitive_units[k] || {};
      if (ms.k !== kk || ms.n !== nn) probs.push(k + ": sensitive units differ from the file's analysis");
    });
    return { probs: probs, counts: counts, pairs: pairs, sens: sens, n: rows.length };
  }
  var V = recompute();
  if (V.probs.length) {
    banner("s4-bad", "Not shown: the results did not verify", V.probs.slice(0, 5).join("; ") + ". Nothing from this file is displayed.");
    return;
  }

  // ------------------------------------------------------------ display
  if (fake) banner("s4-fake", "FAKE / NOT SCIENTIFIC EVIDENCE", D.stamp + ". This is a dry run of the results pipeline with simulated answers. Its numbers say nothing about any model and must not be cited.");
  else banner("s4-live", "Recorded results: " + D.model_id, "One model, the 12 frozen scenarios. Descriptive results; no significance tests. Every count below was recomputed in this page from " + V.n + " decision records.");
  $("s4-out").hidden = false;
  Array.prototype.forEach.call(document.querySelectorAll("#s4-out h2, #s4-out h3"), function (x) { x.textContent = tag(x.textContent); });
  $("s4-verified").textContent = "Verified in this page: the decision rows match their sha256 (" + String(D.decisions_sha256).slice(0, 16) + "…), every row's outcome follows from its answer, and the outcome counts, pair classes and sensitive units recomputed from " + V.n + " rows equal the analysis.";
  var main = D.report.main;
  var t = $("s4-outcomes"), hr = add(add(t, h("thead")), h("tr"));
  ["Condition", "Matched", "Opposite", "Unclear", "Invalid", "Missing", "Sensitive units (k/n)"].forEach(function (x) { add(hr, h("th", null, x)); });
  var tb = add(t, h("tbody"));
  main.conditions.forEach(function (k) {
    var tr = add(tb, h("tr")), th = add(tr, h("th", null, tag(LABEL[k] || k))); th.scope = "row";
    OUT.forEach(function (o) { add(tr, h("td", null, String(V.counts[k][o]))); });
    add(tr, h("td", null, V.sens[k].k + " / " + V.sens[k].n));
  });
  var p = $("s4-pairs"), ph = add(add(p, h("thead")), h("tr"));
  ["Condition"].concat(PAIRS.map(function (x) { return x.replace(/_/g, " "); })).forEach(function (x) { add(ph, h("th", null, x)); });
  var pb = add(p, h("tbody"));
  main.conditions.forEach(function (k) {
    var tr = add(pb, h("tr")), th = add(tr, h("th", null, tag(LABEL[k] || k))); th.scope = "row";
    PAIRS.forEach(function (x) { add(tr, h("td", null, String(V.pairs[k][x]))); });
  });
  function est(parent, name, e) {
    var box = add(parent, h("div", "s4-est"));
    add(box, h("b", null, tag(name)));
    if (!e || e.mean === null) { add(box, h("p", null, "Not estimable: no paired data.")); return; }
    var ul = add(box, h("ul"));
    add(ul, h("li", null, "Difference in the share of paired-sensitive units (both opposite priorities got their own option), averaged over " + e.n + " scenarios: " + e.mean + ", 95% percentile bootstrap interval [" + e.ci95[0] + ", " + e.ci95[1] + "] (" + e.paired_units + " paired units)."));
    if (e.sign) add(ul, h("li", null, "Scenarios with a positive / zero / negative difference: " + e.sign.positive + " / " + e.sign.zero + " / " + e.sign.negative + "."));
    (e.warnings || []).forEach(function (w) { add(ul, h("li", null, "Warning: " + w + ".")); });
  }
  var pr = $("s4-primary"); pr.replaceChildren();
  est(pr, "P1: Direct − After six handoffs", main.primary.P1_direct_minus_delegated);
  est(pr, "P2: Restated − After six handoffs", main.primary.P2_restored_minus_delegated);
  add(pr, h("p", "small", main.primary.note + " P2 is the difference in paired sensitivity when the original priority is restated at the final decision, over the identical handoff 6, in these sampled runs. It shows the model follows an instruction placed in front of it; it does not show better decisions and does not isolate a mechanism."));
  var se = $("s4-sens"); se.replaceChildren();
  var a = D.report.sensitivity_missing_as_not_sensitive, b = D.report.sensitivity_tolerant_parser;
  est(se, "Missing counted as not sensitive: P1", a.P1_direct_minus_delegated); est(se, "Missing counted as not sensitive: P2", a.P2_restored_minus_delegated);
  est(se, "Tolerant answer parser: P1", b.P1_direct_minus_delegated); est(se, "Tolerant answer parser: P2", b.P2_restored_minus_delegated);
  var fc = D.report.format_compliance;
  add(se, h("p", "small", "Answers not in the strict form: " + fc.strict_invalid + " (of which a tolerant reading finds A or B in " + fc.strict_invalid_but_tolerant_A_or_B + ")."));
  // no-priority baselines (matched conditions), recomputed from the rows; declines set beside the priority conditions
  var NP = { direct_no_priority: "No priority, asked directly (3 draws per scenario and order)", np_chain_decision: "No priority, after six handoffs" };
  var nt = $("s4-np"), nh = add(add(nt, h("thead")), h("tr"));
  ["Condition", "Decisions", "Chose an option", "Declined (UNCLEAR)", "Declined share"].forEach(function (x) { add(nh, h("th", null, x)); });
  var nb = add(nt, h("tbody"));
  function npRow(label, rows) {
    var d = rows.filter(function (r) { return r.strict === "UNCLEAR"; }).length, c = rows.filter(function (r) { return r.strict === "A" || r.strict === "B"; }).length;
    var tr = add(nb, h("tr")), th = add(tr, h("th", null, tag(label))); th.scope = "row";
    [rows.length, c, d, Math.round(100 * d / rows.length) + "%"].forEach(function (x) { add(tr, h("td", null, String(x))); });
  }
  ["direct", "delegated", "restored"].forEach(function (k) { npRow(LABEL[k] + " (priority given)", D.decisions.filter(function (r) { return r.condition === k; })); });
  Object.keys(NP).forEach(function (k) { npRow(NP[k], D.decisions.filter(function (r) { return r.condition === k; })); });
  var O = main.outcome_counts, U = main.sensitive_units;
  $("s4-summary").textContent = "Told the priority directly, the final decision gave each of two opposite priorities its own option in " + U.direct.k + " of " + U.direct.n +
    " pairs. After six AI handoffs: " + U.delegated.k + " of " + U.delegated.n + ". With the priority restated at the final step: " + U.restored.k + " of " + U.restored.n +
    ". After the handoffs the decisions resembled the model's decisions without any priority (similar decline rates; table below). Descriptive results from a controlled experiment.";
  var pv = D.provenance, tech = pv.technical || {};
  var dl = $("s4-prov"); dl.replaceChildren();
  [["Mode", D.mode + " · " + D.stamp], ["Model", D.model_id + "; served: " + ((tech.served_models || []).join(", ") || "?")],
    ["Frozen items (sha256)", pv.items_sha256], ["Plan (sha256)", pv.plan_sha256 + " · design option " + pv.design_option],
    ["Config (sha256)", pv.config_sha256], ["Ledger (sha256)", pv.ledger_sha256], ["Decision rows (sha256)", D.decisions_sha256],
    ["Run", (tech.completed || "?") + " of " + (tech.units || "?") + " units completed; " + (tech.attempts || "?") + " attempts; truncated " + tech.truncated + ", blocked " + tech.blocked + "; charged $" + tech.spent_usd_charged + " of $" + tech.cap_usd],
    ["Authorization · unseal", (pv.authorization_present ? "authorized run" : "no authorization (not a live run)") + " · " + (pv.unsealed ? "unsealed" : "not unsealed")],
    ["Responses from the fake transport", pv.fake_transport_responses + " of " + pv.responses],
    ["Generated", D.generated_at]].forEach(function (x) { add(dl, h("dt", null, x[0])); add(dl, h("dd", null, String(x[1]))); });
  $("s4-save").addEventListener("click", function () {
    var url = URL.createObjectURL(new Blob([JSON.stringify(D, null, 1) + "\n"], { type: "application/json" }));
    var l = document.createElement("a"); l.href = url; l.download = "study4_results_" + D.mode.toLowerCase() + ".json";
    document.body.appendChild(l); l.click(); l.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  window.__study4State = function () { return { mode: D.mode, verified: true, rows: V.n }; };
})();
