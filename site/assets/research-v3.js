// Research pages: opens the collapsible section that holds the linked anchor, so every earlier deep link
// (#study3b, #behavior, #S016-A14/3, #ref-…, #explore, #limits, #q-forgot, …) still lands on visible content.
(function () {
  "use strict";
  function target() {
    var h = decodeURIComponent((location.hash || "").slice(1));
    if (!h) return null;
    var id = h.split("/")[0];
    if (/^(S\d{3}-A\d{2}|ref-|explore)/.test(id)) id = "explore";
    return document.getElementById(id);
  }
  function openTo(el) {
    for (var n = el; n; n = n.parentElement) if (n.tagName === "DETAILS") n.open = true;
  }
  function go(scroll) {
    var el = target(); if (!el) return;
    openTo(el);
    if (scroll) setTimeout(function () { el.scrollIntoView({ block: "start" }); }, 0);
  }
  go(true);
  window.addEventListener("hashchange", function () { go(true); });
  // in-page links to a section inside a closed block
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a && a.getAttribute("href") === location.hash) go(true);
  });
})();
