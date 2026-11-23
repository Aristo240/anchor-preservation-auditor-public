// Home: fills the Study 4 figures from window.STUDY4_RESULTS (verified LIVE results); no numbers are computed by hand.
// The hero figures are also typed into the page so it reads without JavaScript; here they are re-set from the data.
(function () {
  "use strict";
  var S = window.STUDY4_RESULTS; if (!S || S.mode !== "LIVE") return;
  function set(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  var M = S.report.main, U = M.sensitive_units, O = M.outcome_counts;
  function of(x) { return x.k + " of " + x.n; }
  var HF = { dir: of(U.direct), del: of(U.delegated), res: of(U.restored) };
  Array.prototype.forEach.call(document.querySelectorAll("#hero-result [data-h]"), function (e) { e.textContent = HF[e.getAttribute("data-h")]; });
  set("h-n-dir", of(U.direct)); set("h-n-del", of(U.delegated)); set("h-n-res", of(U.restored));
  set("h-lim", "Gemini 2.5 Pro, 12 constructed scenarios × 2 opposite priorities × 2 option orders (× 2 independent chains after handoffs). A pair counts only if both opposite priorities got their own option. Restating the priority shows the model follows an instruction placed in front of it, not that its decisions were better.");
  function n(c) { var o = O[c], t = 0; for (var k in o) t += o[k]; return t; }
  set("h-pairs", "Single decisions that matched the priority: told directly " + O.direct.matched + " of " + n("direct") + "; after six handoffs " +
    O.delegated.matched + " of " + n("delegated") + " (" + O.delegated.opposite + " chose the other option, " + O.delegated.unclear +
    " declined to choose); restated " + O.restored.matched + " of " + n("restored") + ".");
  var np = { direct_no_priority: [0, 0], np_chain_decision: [0, 0] };
  S.decisions.forEach(function (d) { if (np[d.condition]) { np[d.condition][1]++; if (d.strict === "UNCLEAR") np[d.condition][0]++; } });
  function pct(a, b) { return Math.round(100 * a / b) + "%"; }
  set("h-base", "With no priority at all, the model declined to choose in " + pct(np.direct_no_priority[0], np.direct_no_priority[1]) +
    " of direct decisions and " + pct(np.np_chain_decision[0], np.np_chain_decision[1]) + " after six handoffs. With the priority given only at the start, it declined in " +
    pct(O.delegated.unclear, n("delegated")) + " after six handoffs; told the priority directly or restated, never.");
  set("h-alt", "This is a comparison of behaviour, not a demonstration of literal forgetting: we did not test what the handoff texts contained.");
})();
