// Results explorer (Study 3B). Every number is counted here from window.STUDY3B (built by
// auditor/build_study3b_showcase.py from the verified records); nothing is typed into the page.
(function () {
  "use strict";
  var S = window.STUDY3B; if (!S) return;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return arguments[arguments.length - 1]; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  var N = S.n_cases;
  var CONDS = ["direct", "delegated", "restored", "reanchored"];
  var NAME = { direct: "Told directly", delegated: "Handoff only", restored: "Priority repeated at the final decision", reanchored: "Priority re-added at step 4" };
  var SUBN = { direct: "no handoffs; the priority is in the decision prompt", delegated: "the final decision received handoff 6, but not the priority as a separate instruction",
               restored: "the same handoff 6 plus one line repeating the priority", reanchored: "newly generated handoffs 4–6; not a final-prompt comparison" };
  var SYM = { matched: "✓", opposite: "⇄", unclear: "?" };
  var WORD = { matched: "matched", opposite: "other option", unclear: "declined" };
  var SCEN = []; S.cases.forEach(function (c) { if (SCEN.indexOf(c.scenario) < 0) SCEN.push(c.scenario); });
  function cs(sc, o, p) { return S.cases.filter(function (c) { return c.scenario === sc && c.order === o && c.priority_index === p; })[0]; }
  function sgn(z) { return (z >= 0 ? "+" : "−") + Math.abs(z).toFixed(2); }

  // ---------------------------------------------------------------- bars
  var bars = $("bars");
  CONDS.forEach(function (k) {
    var n = S.counts[k], row = add(bars, h("div", "brow")); row.setAttribute("data-cond", k);
    var lab = add(row, h("div", "lab")); add(lab, h("b", null, NAME[k])); add(lab, h("small", null, SUBN[k]));
    var b = add(row, h("div", "bar28")); b.setAttribute("role", "img");
    b.setAttribute("aria-label", NAME[k] + ": " + n.matched + " matched, " + n.opposite + " chose the other option, " + n.unclear + " declined, of " + N);
    ["matched", "opposite", "unclear"].forEach(function (o) { if (n[o]) { var s = add(b, h("span", "bg-" + o)); s.style.width = (100 * n[o] / N) + "%"; } });
    add(row, h("span", "nums", n.matched + " · " + n.opposite + " · " + n.unclear + " of " + N));
  });

  // ---------------------------------------------------------------- the 28 cases
  var FIL = [["all", "All", function () { return true; }],
             ["opposite", "Changed: was the other option", function (c) { return c.outcomes.delegated === "opposite"; }],
             ["unclear", "Changed: was declined", function (c) { return c.outcomes.delegated === "unclear"; }],
             ["same", "Same choice both times", function (c) { return c.outcomes.delegated === c.outcomes.restored; }]];
  var cur = "all";
  function drawFilters() {
    var f = clear($("filters"));
    FIL.forEach(function (x) {
      var n = S.cases.filter(x[2]).length, b = add(f, h("button", "chip")); b.type = "button";
      add(b, document.createTextNode(x[1])); add(b, h("span", "ct", "· " + n));
      b.setAttribute("aria-pressed", cur === x[0] ? "true" : "false"); b.setAttribute("data-filter", x[0]);
      b.addEventListener("click", function () {                 // v4 review fix: keep keyboard focus on the chip
        var i = Array.prototype.indexOf.call($("filters").children, b), had = document.activeElement === b;
        cur = x[0]; drawFilters(); drawGrid();
        if (had) $("filters").children[i].focus();
      });
    });
  }
  function drawGrid() {
    var g = clear($("grid")), test = FIL.filter(function (x) { return x[0] === cur; })[0][2], shown = 0;
    ["Decision", "Priority 1 · as built", "Priority 1 · swapped", "Priority 2 · as built", "Priority 2 · swapped"].forEach(function (t) { add(g, h("div", "gh", t)); });
    SCEN.forEach(function (sc) {
      var any = cs(sc, "orig", "p0"), dn = add(g, h("div", "dn"));
      add(dn, document.createTextNode(any.title)); add(dn, h("small", null, any.pair_label));
      [["p0", "orig"], ["p0", "swap"], ["p1", "orig"], ["p1", "swap"]].forEach(function (k) {
        var c = cs(sc, k[1], k[0]), a = add(g, h("a", "cell")), on = test(c);
        a.href = "experiment.html#replay/" + c.id; a.setAttribute("data-case", c.id); a.setAttribute("data-group", c.outcomes.delegated);
        a.setAttribute("data-dim", on ? "false" : "true"); if (on) shown++;
        add(a, h("span", "fine", c.focal_value + " first · " + (c.order === "orig" ? "as built" : "swapped")));
        var p = add(a, h("span", "pair"));
        add(p, h("span", "o-" + c.outcomes.delegated, SYM[c.outcomes.delegated] + " " + WORD[c.outcomes.delegated]));
        add(p, h("span", "ar", "→")); add(p, h("span", "o-" + c.outcomes.restored, SYM[c.outcomes.restored] + " " + WORD[c.outcomes.restored]));
        a.setAttribute("aria-label", any.title + ", " + c.focal_value + " first, " + (c.order === "orig" ? "as built" : "options swapped") +
          ": handoff only " + WORD[c.outcomes.delegated] + ", with the priority repeated " + WORD[c.outcomes.restored] + ". Step through this case");
      });
    });
    $("count").textContent = (cur === "all" ? "All " + N + " cases" : shown + " of " + N + " cases highlighted") + ". Left: handoff only. Right: the same handoff 6 with the priority repeated.";
  }
  drawFilters(); drawGrid();

  // ---------------------------------------------------------------- stricter test and baseline
  var sv = $("sens"), PS = S.paired_sensitive_orders;
  $("sens-lead").textContent = "Both opposing priorities produced their own matching option in " + PS.delegated.k + " of " + PS.delegated.n +
    " decision-and-order pairs with the handoff only, compared with " + PS.direct.k + " of " + PS.direct.n + " when told directly and " +
    PS.restored.k + " of " + PS.restored.n + " with the priority repeated at the final decision.";
  ["direct", "delegated", "restored"].forEach(function (k) {
    var x = S.paired_sensitive_orders[k], d = add(sv, h("div", "num")); d.setAttribute("data-cond", k);
    add(d, h("strong", null, x.k + " of " + x.n)); add(d, h("span", null, NAME[k]));
  });
  var np = S.no_priority.choices;
  $("np-line").textContent = "With no priority at all (task and options only, no target), the model chose A in " + (np.A || 0) + ", B in " + (np.B || 0) +
    " and declined in " + (np.ABSTAIN || 0) + " of " + S.no_priority.n + " decision-and-order pairs, so a choice can fit a priority by coincidence.";

  // ---------------------------------------------------------------- re-adding at step 4 (counterexample)
  (function () {
    var gained = 0, lost = 0;
    S.cases.forEach(function (c) {
      if (c.outcomes.delegated !== "matched" && c.outcomes.reanchored === "matched") gained++;
      if (c.outcomes.delegated === "matched" && c.outcomes.reanchored !== "matched") lost++;
    });
    var o = $("counter-in"), x = S.cases.filter(function (c) { return c.id === S.selection.counterexample; })[0];
    add(o, h("p", "warn", "This is a different intervention from repeating the priority at the final decision. Handoffs 1–3 were kept; handoff 4 was newly generated with the priority inserted, and handoffs 5–6 were newly generated after it. Its differences from “handoff only” therefore mix the inserted priority with ordinary run-to-run variation."));
    add(o, h("p", null, "Compared case by case with “handoff only”, " + gained + " cases matched only after re-adding and " + lost + " matched only without it. Overall: " +
      S.counts.reanchored.matched + " matched, " + S.counts.reanchored.opposite + " chose the other option, " + S.counts.reanchored.unclear + " declined. Both opposing priorities got their own option in " +
      S.paired_sensitive_orders.reanchored.k + " of " + S.paired_sensitive_orders.reanchored.n + " pairs. With one run per case, these differences don't isolate the effect of the inserted priority."));
    var p = add(o, h("p", null, "The prespecified counterexample: " + x.title + ", " + x.focal_value + " first, " + (x.order === "orig" ? "options as built" : "options swapped") +
      ". Handoff only: " + WORD[x.outcomes.delegated] + "; re-added at step 4: " + WORD[x.outcomes.reanchored] + ". "));
    var a = add(p, h("a", null, "Open this case")); a.href = "experiment.html#case/" + x.id + "/reanchored";
    add(o, h("p", "fine", "Chosen by a fixed rule: " + S.selection.counterexample_rule + "."));
  })();

  // ---------------------------------------------------------------- intervals
  (function () {
    var o = $("stats-in"), w = add(o, h("div", "table-wrap")), t = add(w, h("table", "dt")), hr = add(add(t, h("thead")), h("tr"));
    ["Condition", "Sensitive decision-orders", "Mean over 7 decisions", "Bootstrap 95% interval"].forEach(function (x) { add(hr, h("th", null, x)); });
    var b = add(t, h("tbody"));
    CONDS.forEach(function (k) {
      var m = S.mean_paired_sensitivity[k], r = add(b, h("tr")); r.setAttribute("data-cond", k);
      add(r, h("td", null, NAME[k])); add(r, h("td", null, S.paired_sensitive_orders[k].k + " of 14")); add(r, h("td", null, m.estimate.toFixed(2)));
      add(r, h("td", null, m.degenerate ? "no variation among the 7 scenarios (not certainty)" : m.bootstrap_ci95[0].toFixed(2) + " to " + m.bootstrap_ci95[1].toFixed(2)));
    });
    var w2 = add(o, h("div", "table-wrap")), t2 = add(w2, h("table", "dt")), h2 = add(add(t2, h("thead")), h("tr"));
    ["Difference (mean of per-scenario differences)", "Estimate", "Bootstrap 95% interval"].forEach(function (x) { add(h2, h("th", null, x)); });
    var b2 = add(t2, h("tbody"));
    [["direct_minus_delegated", "Told directly − Handoff only"], ["restored_minus_delegated", "Priority repeated − Handoff only"],
     ["reanchored_minus_delegated", "Re-added at step 4 − Handoff only"], ["restored_minus_reanchored", "Priority repeated − Re-added at step 4"]].forEach(function (x) {
      var v = S.contrasts[x[0]], r = add(b2, h("tr")); r.setAttribute("data-contrast", x[0]);
      add(r, h("td", null, x[1])); add(r, h("td", null, sgn(v.estimate))); add(r, h("td", null, v.bootstrap_ci95.map(sgn).join(" to ")));
    });
    add(o, h("p", "fine", "These are descriptive results from 7 previously studied scenarios, not a hypothesis test. When every scenario has the same value, the interval collapses to a point; that reflects no variation in this small set, not certainty. A low matching rate is not, by itself, evidence that choices were made at chance."));
  })();

  // ---------------------------------------------------------------- value-name diagnostic
  (function () {
    var o = $("names-in");
    add(o, h("p", null, "Whether handoff 6 contains the prioritized value's name (for example “Achievement”) as a whole word, and what the final decision did."));
    var w = add(o, h("div", "table-wrap")), t = add(w, h("table", "dt")), hr = add(add(t, h("thead")), h("tr"));
    ["Condition", "Handoff 6 names the value", "of which matched", "Doesn't name it", "of which matched"].forEach(function (x) { add(hr, h("th", null, x)); });
    var b = add(t, h("tbody"));
    ["delegated", "reanchored"].forEach(function (k) {
      var yes = S.cases.filter(function (c) { return c.t6_names_value && c.t6_names_value[k]; }), no = S.cases.filter(function (c) { return !(c.t6_names_value && c.t6_names_value[k]); });
      var m = function (xs) { return xs.filter(function (c) { return c.outcomes[k] === "matched"; }).length; };
      var r = add(b, h("tr")); r.setAttribute("data-cond", k);
      [NAME[k], String(yes.length), String(m(yes)), String(no.length), String(m(no))].forEach(function (x) { add(r, h("td", null, x)); });
    });
    add(o, h("p", "fine", "A literal word match specified before unsealing, not a semantic classifier: it misses paraphrases and can catch incidental uses. It is not a validated predictor of the choice. Mentioning a value is not the same as following it."));
  })();

  // ---------------------------------------------------------------- full table with filters
  (function () {
    var o = $("table-in"), f = add(o, h("div", "chipbar")), sel = {};
    function select(id, label, opts) {
      var l = add(f, h("label", "small", label + " ")), s = h("select"); s.id = id;
      opts.forEach(function (x) { var op = add(s, h("option", null, x[1])); op.value = x[0]; });
      s.addEventListener("change", draw); add(l, s); sel[id] = s;
    }
    select("f-scenario", "Decision", [["", "All"]].concat(SCEN.map(function (sc) { return [sc, cs(sc, "orig", "p0").title]; })));
    var vals = []; S.cases.forEach(function (c) { if (vals.indexOf(c.focal_value) < 0) vals.push(c.focal_value); });
    select("f-value", "Prioritized value", [["", "All"]].concat(vals.map(function (v) { return [v, v]; })));
    select("f-order", "Option order", [["", "All"], ["orig", "As built"], ["swap", "Swapped"]]);
    select("f-cond", "Condition", [["", "Any"]].concat(CONDS.map(function (k) { return [k, NAME[k]]; })));
    select("f-outcome", "Outcome", [["", "Any"], ["matched", "Matched"], ["opposite", "Other option"], ["unclear", "Declined (UNCLEAR)"]]);
    var w = add(o, h("div", "table-wrap")), t = add(w, h("table", "dt")), hr = add(add(t, h("thead")), h("tr"));
    ["Decision", "Priority", "Order"].concat(CONDS.map(function (k) { return NAME[k]; })).concat(["No priority (baseline)"]).forEach(function (x) { add(hr, h("th", null, x)); });
    var body = add(t, h("tbody")), cnt = add(o, h("p", "fine"));
    function draw() {
      clear(body); var n = 0;
      S.cases.forEach(function (c) {
        var v = function (id) { return sel[id].value; };
        if (v("f-scenario") && c.scenario !== v("f-scenario")) return;
        if (v("f-value") && c.focal_value !== v("f-value")) return;
        if (v("f-order") && c.order !== v("f-order")) return;
        if (v("f-outcome")) { var ks = v("f-cond") ? [v("f-cond")] : CONDS; if (!ks.some(function (k) { return c.outcomes[k] === v("f-outcome"); })) return; }
        n++;
        var r = add(body, h("tr")); r.setAttribute("data-case", c.id);
        var td = add(r, h("td")), a = add(td, h("a", null, c.title)); a.href = "experiment.html#case/" + c.id;
        add(r, h("td", null, c.focal_value)); add(r, h("td", null, c.order === "orig" ? "as built" : "swapped"));
        CONDS.forEach(function (k) { add(r, h("td", "o-" + c.outcomes[k], SYM[c.outcomes[k]] + " " + WORD[c.outcomes[k]])); });
        add(r, h("td", null, c.no_priority_choice === "ABSTAIN" ? "declined" : c.no_priority_choice));
      });
      cnt.textContent = n + " of " + N + " cases shown.";
    }
    draw();
  })();
  $("sel-rules").textContent = "Examples are chosen by fixed rules, not to be typical. Opening example: " + S.selection.opening_rule + ". Counterexample: " + S.selection.counterexample_rule + ".";
  function openHash() { var el = location.hash && document.getElementById(location.hash.slice(1)); if (el && el.tagName === "DETAILS") { el.open = true; el.scrollIntoView({ block: "start" }); } }
  openHash(); window.addEventListener("hashchange", openHash);
})();
