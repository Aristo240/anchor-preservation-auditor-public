// Fills the journey summary lines from window.STUDY3B; no numbers are typed into the page.
(function () {
  "use strict";
  var S = window.STUDY3B;
  if (!S) return;
  var n = S.counts;
  function set(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  var better = 0, worse = 0;
  S.cases.forEach(function (c) {
    var d = c.outcomes.delegated === "matched", r = c.outcomes.reanchored === "matched";
    if (r && !d) better++;
    if (d && !r) worse++;
  });
  set("glance-3b", n.delegated.matched + " / 28");
  set("j-deleg", "After six handoffs that carried the priority only at the start, the final decision matched the stated priority in " +
    n.delegated.matched + " of 28 cases, chose the opposite option in " + n.delegated.opposite + " and answered UNCLEAR in " + n.delegated.unclear +
    ". Choosing directly, with the priority in the prompt, it matched in " + n.direct.matched + " of 28.");
  set("j-restore", "Adding the original priority line to the final prompt, with the same handoff, gave " + n.restored.matched + " of 28 matched. " +
    "Regenerating the fourth handoff with the priority instead gave " + n.reanchored.matched + " matched, " + n.reanchored.opposite +
    " opposite and " + n.reanchored.unclear + " UNCLEAR. Compared case by case with Delegated, " + better + " cases matched only after re-anchoring and " + worse +
    " matched only without it; with newly generated handoffs and one run per case, these differences don't isolate a cause.");
})();
