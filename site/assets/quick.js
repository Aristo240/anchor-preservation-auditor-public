// Quick Check: one editable question to paste into your own AI chat. Copies to the clipboard; nothing is stored or sent.
// Binds every .qc block on the page (the homepage section and quick.html use the same markup).
(function () {
  "use strict";
  var ORIGINAL = "Before I decide, compare your recommendation with the priorities and constraints I originally gave you. " +
    "Identify any new considerations you've introduced. If you think something else deserves more weight, explain why " +
    "rather than silently replacing my criteria. If you can't find my original priorities, tell me.";
  window.QUICK_CHECK_TEXT = ORIGINAL;

  function copyText(text, area, msg, okText, btn) {
    function done() { msg.textContent = okText; }
    function fallback() {
      try { area.focus(); area.select(); if (document.execCommand("copy")) { done(); if (btn) btn.focus(); return; } } catch (e) { /* fall through */ }
      msg.textContent = "Couldn't copy automatically. The text is selected: press Ctrl+C (or ⌘C).";
    }
    msg.textContent = "";
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".qc"), function (box) {
    var area = box.querySelector(".qc-text"), copy = box.querySelector(".qc-copy"),
        reset = box.querySelector(".qc-reset"), msg = box.querySelector(".qc-msg");
    if (!area || !copy || !msg) return;
    if (!area.value.trim()) area.value = ORIGINAL;
    function sync() { if (reset) reset.hidden = area.value === ORIGINAL; }
    area.addEventListener("input", function () { sync(); msg.textContent = ""; });
    copy.addEventListener("click", function () {
      var t = area.value.trim();
      if (!t) { msg.textContent = "The question is empty. Restore the original wording or type your own."; return; }
      copyText(t, area, msg, "Copied. Paste it into the same AI chat, after its recommendation.", copy);
    });
    if (reset) reset.addEventListener("click", function () { area.value = ORIGINAL; sync(); msg.textContent = "Original wording restored."; area.focus(); });
    sync();
  });

  var S = window.STUDY3B;                                     // the "why ask" figures, from the frozen pilot data
  if (S) {
    var F = { n: String(S.n_cases), del: S.counts.delegated.matched + " of " + S.n_cases, res: S.counts.restored.matched + " of " + S.n_cases };
    Array.prototype.forEach.call(document.querySelectorAll("[data-s3b]"), function (e) { e.textContent = F[e.getAttribute("data-s3b")]; });
  }
})();
