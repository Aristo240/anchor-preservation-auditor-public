// Study 3C and cross-model results pages: render window.EXTRA_RESULTS (built by release/tools/build_extra_results.py
// from verified private runs). Numbers, codes and ids only. No network, no storage; textContent only.
(function () {
  "use strict";
  var D = window.EXTRA_RESULTS, page = document.body.getAttribute("data-page");
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
  function pct(x) { return x === null || x === undefined ? "—" : (100 * x).toFixed(1) + "%"; }
  function ci(c) { return c ? "[" + pct(c[0]) + ", " + pct(c[1]) + "]" : "—"; }
  function table(id, head, rows) {
    var t = $(id), tr = h("tr"); t.replaceChildren();
    head.forEach(function (x) { tr.appendChild(h("th", null, x)); }); t.appendChild(h("thead")).appendChild(tr);
    var b = t.appendChild(h("tbody"));
    rows.forEach(function (r) { var q = h("tr"); r.forEach(function (x) { q.appendChild(h("td", null, x)); }); b.appendChild(q); });
  }
  function banner(cls, title, text) { var b = h("div", "s4-banner " + cls); b.appendChild(h("b", null, title)); b.appendChild(h("span", null, text)); $("x-status").replaceChildren(b); }
  if (!D) { banner("s4-none", "Not yet available", "No verified results file is present."); return; }

  if (page === "models") {
    var X = D.cross_model, COND = { D: "Direct", L: "Delegated", R: "Restated", N: "Direct, no priority", U: "Chain, no priority" };
    banner("s4-live", "LIVE · verified", "Every arm's ledger chain, call records and settlements were verified before this file was built. Exploratory; descriptive only.");
    $("x-scope").textContent = X.scope_note;
    table("x-arms", ["Arm", "Model id", "Calls recorded", "Records", "Spend (run + check)", "Cap"], X.order.map(function (k) {
      var a = X.arms[k]; return [k, a.model_id, a.calls_logged, a.records, "$" + (a.run_usd + a.techcheck_usd).toFixed(2), "$" + a.cap_total_usd];
    }).concat(X.not_run.map(function (n) { return [n.label, n.status, "0", "0", "$0", "—"]; })));
    var ul = $("x-notes");
    var gk = X.order.filter(function (k) { return k.indexOf("gpt") === 0; })[0], gi = X.invalid_post_hoc[gk] || {}, gn = 0, gu = 0;
    for (var kk in gi) { gn += gi[kk]; if (kk.indexOf("UNCLEAR") >= 0) gu += gi[kk]; }
    ul.appendChild(h("li", null, "GPT-5.5: " + gu + " of its " + gn + " INVALID decisions begin \"FIRST CHOICE: UNCLEAR.\" with a trailing period. The prespecified strict format counts them as INVALID (kept in the table); read as written, they are declines to choose. A tolerant parser was not prespecified for this comparison."));
    function cell(arm, dir, cond) { return X.cells.filter(function (c) { return c.arm === arm && c["class"] === "clean_paired" && c.direction === dir && c.condition === cond; })[0]; }
    var ck = X.order.filter(function (k) { return k.indexOf("claude") === 0; })[0], la = cell(ck, "A", "L"), lb = cell(ck, "B", "L"), na = cell(ck, "A", "N");
    ul.appendChild(h("li", null, "Claude Sonnet 5.5 after delegation (clean items): chose the direction-A option in " + la.counts.A + " of " + la.cases + " cases when that was the priority, and in " + lb.counts.A + " of " + lb.cases +
      " when the opposite priority was given. Without any priority it chose that same option in " + na.counts.A + " of " + na.cases + ". Its high match rate in direction A reflects its default, not sensitivity to the priority."));
    var rows = X.cells.filter(function (c) { return c.measure === "priority_match" || c.measure === "coincides_with_direction"; });
    rows.sort(function (a, b) { return (a["class"] + a.direction + a.condition + X.order.indexOf(a.arm)).localeCompare(b["class"] + b.direction + b.condition + X.order.indexOf(b.arm)); });
    table("x-cells", ["Class", "Direction", "Condition", "Arm", "Items", "Cases", "A", "B", "Unclear", "Refusal", "Invalid", "Missing", "Matched", "Rate (all cases)", "Rate (A/B only)"], rows.map(function (c) {
      var n = c.counts; return [c["class"], c.direction, COND[c.condition] || c.condition, c.arm.split("@")[0], c.items, c.cases, n.A, n.B, n.UNCLEAR, n.REFUSAL, n.INVALID, n.MISSING, c.matched, pct(c.rate_all_cases), pct(c.rate_among_A_B)];
    }));
    table("x-derived", ["Class", "Direction", "Measure", "Arm", "Count / defined cases", "Rate", "95% CI (family bootstrap)"], X.derived.map(function (d) {
      return [d["class"], d.direction, d.measure.replace(/_/g, " "), d.arm.split("@")[0], d.count + " / " + d.cases_defined, pct(d.rate), ci(d.ci95_family_bootstrap)];
    }));
    $("x-prov").textContent = "Items sha256 " + X.items_sha256 + " · analysis sha256 " + X.analysis_sha256 + " · bootstrap B=" + X.bootstrap.B + ", seed " + X.bootstrap.seed + ", clustered by " + X.bootstrap.cluster + ".";
  }

  if (page === "study3c") {
    var C = D.study3c, ks = ["t1", "t2", "t3", "t4", "t5", "t6"];
    banner("s4-live", "LIVE · verified", C.units + " decisions plus the identity probe, all served by " + C.served_model + "; every raw record matched its hash. Exploratory; descriptive only. Spend $" + C.cost_usd_charged.toFixed(2) + " of $" + C.cap_usd + ".");
    table("x-check", ["Checkpoint", "Role", "Source", "Matched", "Opposite", "Unclear", "Invalid", "Matched share", "Scenario-level estimate", "95% CI (bootstrap)", "Paired sensitivity", "95% CI"], ks.map(function (k) {
      var c = C.checkpoints[k], s = c.matched_share_scenario_level, p = c.paired_sensitivity_scenario_level;
      return [k.toUpperCase(), c.role, c.source, c.counts.matched, c.counts.opposite, c.counts.UNCLEAR, c.counts.INVALID, c.matched_share_all_cases.k + "/" + c.matched_share_all_cases.n, pct(s.estimate), ci(s.bootstrap_ci95), pct(p.estimate), ci(p.bootstrap_ci95)];
    }));
    table("x-contrast", ["Contrast", "Roles", "Matched share difference", "95% CI (bootstrap)", "Paired sensitivity difference", "95% CI"], Object.keys(C.adjacent_contrasts).map(function (k) {
      var c = C.adjacent_contrasts[k], m = c.matched_share_difference_scenario_level, p = c.paired_sensitivity_difference_scenario_level;
      return [k.toUpperCase(), c.roles, pct(m.estimate), ci(m.bootstrap_ci95), pct(p.estimate), ci(p.bootstrap_ci95)];
    }));
    var r = C.t6_replicate;
    $("x-t6").textContent = "T6 asked again in the 3C session: matched " + r.matched_share.k + "/" + r.matched_share.n + " (" + pct(r.matched_share.share) + "); same outcome as the original T6 in " + r.same_outcome_as_original_t6.k + "/" + r.same_outcome_as_original_t6.n + " cases (" + pct(r.same_outcome_as_original_t6.share) + "). " + r.note;
    var pats = C.trajectories.patterns;
    table("x-traj", ["Trajectory T1→T6", "Cases"], Object.keys(pats).map(function (k) { return [k, pats[k]]; }));
    $("x-traj-legend").textContent = C.trajectories.legend + " · always matched: " + C.trajectories.always_matched + " · matched again after a non-match: " + C.trajectories.cases_matching_again_after_a_non_match;
    var ul = $("x-limits"); C.interpretation_limits.forEach(function (x) { ul.appendChild(h("li", null, x)); });
    $("x-prov").textContent = "Plan sha256 " + C.plan_sha256 + " · analysis sha256 " + C.analysis_sha256 + ".";
  }
  $("x-out").hidden = false;
})();
