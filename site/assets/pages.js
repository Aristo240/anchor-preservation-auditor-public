// Fills every <span data-n="key"> on the text pages from the data files (window.STUDY3B, SHOWCASE_DATA,
// SINGLE_TURN). No number in the page prose is typed by hand. An unknown key is left as "–" and logged.
(function () {
  "use strict";
  var S = window.STUDY3B, D = window.SHOWCASE_DATA, T = window.SINGLE_TURN;
  function signed(x) { var s = Math.abs(x).toFixed(2); return (x < 0 && Number(s) !== 0 ? "−" : "+") + s; }
  var V = {};
  if (S) {
    ["direct", "delegated", "restored", "reanchored"].forEach(function (k) {
      ["matched", "opposite", "unclear"].forEach(function (o) { V["s3b." + k + "." + o] = S.counts[k][o]; });
      V["s3b.sens." + k] = S.paired_sensitive_orders[k].k;
    });
    V["s3b.named.delegated"] = S.t6_names_value.delegated.named;
    V["s3b.named.reanchored"] = S.t6_names_value.reanchored.named;
    V["s3b.prov.plan"] = S.provenance.plan_sha256.slice(0, 16) + "…";
    V["s3b.prov.ledger"] = S.provenance.ledger_head_sha256.slice(0, 16) + "…";
    V["s3b.prov.manifest"] = S.provenance.raw_manifest_sha256.slice(0, 16) + "…";
  }
  if (D) {
    var r = D.headline.delta_by_turn;
    V["s1.t1"] = signed(r[0].point); V["s1.t6"] = signed(r[5].point);
  }
  if (T && T.status === "complete") {
    // the same tally as showcase.js stStats
    var pr = 0, prN = 0, eligible = 0;
    T.decisions.forEach(function (d) {
      d.priority_responses.forEach(function (x) { prN++; if (x.parsed === x.correct_choice) pr++; });
      var allOK = Object.keys(d.orders).every(function (o) {
        var rs = d.priority_responses.filter(function (x) { return x.order === o; });
        return rs.length === 2 && rs.every(function (x) { return x.parsed === x.correct_choice; });
      });
      if (d.default_class === "stable_substantive" && allOK) eligible++;
    });
    V["s2.pr"] = pr; V["s2.prN"] = prN; V["s2.eligible"] = eligible;
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-n]"), function (e) {
    var k = e.getAttribute("data-n");
    if (Object.prototype.hasOwnProperty.call(V, k)) e.textContent = String(V[k]);
    else if (window.console) console.warn("pages.js: no value for " + k);
  });
})();
