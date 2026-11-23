// Priority Checkpoint brief: builds an editable text from four fields. Runs in this tab only; nothing is stored or sent.
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  var F = { decision: $("cp-decision"), matters: $("cp-matters"), constraint: $("cp-constraint") }, out = $("cp-brief"), edited = false;
  var INSTR = {
    ask: "Compare the options against these priorities. If you think another consideration should take priority, explain it and ask me before changing the criteria. When you give your final recommendation, say how it relates to what matters most to me.",
    flag: "Compare the options against these priorities. If you think another consideration should take priority, say so explicitly and explain why, but keep using my criteria unless I change them. When you give your final recommendation, say how it relates to what matters most to me."
  };
  function val(el) { return el.value.trim(); }
  function mode() { var r = document.querySelector('input[name="cp-mode"]:checked'); return r ? r.value : "ask"; }
  function build() {
    var lines = [];
    lines.push("Decision: " + (val(F.decision) || "[the decision you want help with]"));
    lines.push("What matters most: " + (val(F.matters) || "[what matters most to you in this decision]"));
    if (val(F.constraint)) lines.push("Important constraint: " + val(F.constraint));
    lines.push("Instruction: " + INSTR[mode()]);
    return lines.join("\n\n");
  }
  function refresh() { if (!edited) out.value = build(); }
  function regen() { edited = false; $("cp-edited").hidden = true; refresh(); refreshR(); }
  [F.decision, F.matters, F.constraint].forEach(function (el) { el.addEventListener("input", refresh); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="cp-mode"]'), function (r) { r.addEventListener("change", refresh); });
  out.addEventListener("input", function () { if (out.value !== build()) { edited = true; $("cp-edited").hidden = false; } });
  $("cp-regen").addEventListener("click", regen);
  $("cp-example").addEventListener("click", function () {
    F.decision.value = "Choose between two job opportunities.";
    F.matters.value = "Learning and professional growth matter more than prestige.";
    F.constraint.value = "I want to remain based in my current location.";
    regen();
  });
  // v4 W1: the Receipt uses the brief exactly as it was copied or saved (with any edits), not the fields or later edits.
  var copied = null;
  function snapshot(how) { copied = { text: out.value, at: stamp(), how: how }; if (typeof refreshR === "function") refreshR(); }
  var EMPTY = "There is nothing to copy or save yet: fill in the fields or type the text first.";
  // v4 review fix: "Copied" only after a confirmed copy (clipboard API, or execCommand returning true); otherwise the
  // text is left selected with a manual-copy message, and focus goes back to the field that holds the text.
  function copyFrom(area, msg, ok, onOk) {
    var text = area.value.trim();
    msg.textContent = "";
    if (!text) { msg.textContent = EMPTY; return; }
    function done() { if (onOk) onOk(); msg.textContent = ok; }
    function fallback() {
      try { area.focus(); area.select(); if (document.execCommand("copy")) { done(); return; } } catch (e) { /* fall through */ }
      area.focus(); area.select();
      msg.textContent = "Couldn't copy automatically. The text is selected: press Ctrl+C (or \u2318C).";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  $("cp-copy").addEventListener("click", function () {
    copyFrom(out, $("cp-msg"), "Copied. Paste it into your AI chat.", function () { snapshot("copied"); });
  });
  $("cp-dl").addEventListener("click", function () {
    if (!out.value.trim()) { $("cp-msg").textContent = EMPTY; return; }
    var url = URL.createObjectURL(new Blob([out.value + "\n"], { type: "text/plain" })), a = document.createElement("a");
    a.href = url; a.download = "priority-checkpoint.txt"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    snapshot("saved"); $("cp-msg").textContent = "Saved priority-checkpoint.txt.";
  });
  // ---------------------------------------------------------------- step 2: Priority Receipt (the visitor's own review)
  // The page never reads or judges the AI's answer: the follow-up question and the record are built only from the
  // visitor's own fields and choices, with fixed sentences.
  var R = { ai: $("rc-ai"), note: $("rc-note"), q: $("rc-q") }, qEdited = false;
  var LAB = {
    addr: { yes: "Yes", partly: "Partly", no: "No", unsure: "Not sure" },
    change: { no: "No", added: "Yes, alongside mine", replaced: "Yes, instead of mine", unsure: "Not sure" },
    open: { yes: "Yes", no: "No", unsure: "Not sure" },
    nw: { accept: "It should count too", consider: "I'd like to hear why first", reject: "Keep my original criteria" },
    cons: { yes: "Yes", no: "No", unsure: "Not sure" }
  };
  function pick(name) { var r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; }
  function briefText() { return copied ? copied.text : out.value; }
  function fromBrief(label) {                                  // a line of the brief the Receipt is based on
    var m = briefText().match(new RegExp("^" + label + ":[ \\t]*(.+)$", "m")); return m ? m[1].trim() : "";
  }
  function matters() { var b = fromBrief("What matters most"); return (b && b.charAt(0) !== "[" ? b : val(F.matters)) || "[what matters most to you]"; }
  function constraint() { return copied ? fromBrief("Important constraint") : (fromBrief("Important constraint") || val(F.constraint)); }
  function followUp() {
    // Built only from the visitor's own answers, with fixed sentences. v4: W2 added vs replaced; W3 the visitor can accept,
    // consider or reject a new consideration (the question no longer pushes back by default); W4 each "Not sure" gets a question.
    var m = "“" + matters().replace(/[.!?\s]+$/, "") + "”", qs = [], a = pick("rc-addr"), c = pick("rc-change"),
        k = constraint() ? pick("rc-cons") : "", o = pick("rc-open"), n = pick("rc-new");
    if (a === "no") qs.push("You didn't say how your recommendation relates to what matters most to me: " + m + ". How do the options compare on that?");
    if (a === "partly") qs.push("You only partly explained how your recommendation relates to what matters most to me: " + m + ". How do the options compare on that?");
    if (a === "unsure") qs.push("How does your recommendation follow from what matters most to me: " + m + "?");
    if (c === "added" || c === "replaced") {
      var intro = o === "no" ? "Your recommendation seems to rely on a consideration I didn't give" + (c === "replaced" ? ", in place of mine" : "") + ". Which one is it?"
        : o === "unsure" ? "Did your recommendation rely on a consideration I didn't give? If so, which one, and does it add to my criteria or replace them?"
        : "You raised a consideration I didn't give" + (c === "replaced" ? " and put it in place of mine" : "") + ".";
      var act = n === "accept" ? "I agree it should count. Please give your recommendation again, weighing it together with what matters most to me (" + m + "), and show how each option compares on both."
        : n === "reject" ? "I'd like to keep my original criteria (" + m + "). Which option would you recommend on those alone?"
        : "Before I decide whether it should count, explain why it matters here, and tell me which option you'd recommend with it and without it.";
      qs.push(intro + " " + act);
    }
    if (c === "unsure") qs.push("Did your recommendation rely on any consideration beyond what I said matters most (" + m + ")? If so, which one, and does it add to my criteria or replace them?");
    if (k === "no") qs.push("Does your recommendation respect my constraint: “" + constraint().replace(/[.!?\s]+$/, "") + "”? If not, which option does?");
    if (k === "unsure") qs.push("Please check explicitly whether your recommendation respects my constraint: “" + constraint().replace(/[.!?\s]+$/, "") + "”.");
    if (!qs.length) qs.push("Before I decide, is there anything about " + m + " I should double-check?");
    return qs.length === 1 ? qs[0] : qs.map(function (x, i) { return (i + 1) + ". " + x; }).join("\n");
  }
  function stamp() { var d = new Date(); function z(n) { return (n < 10 ? "0" : "") + n; } return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + " " + z(d.getHours()) + ":" + z(d.getMinutes()); }
  function record(md) {
    var a = pick("rc-addr"), c = pick("rc-change"), k = pick("rc-cons"), L = [];
    function hd(t) { L.push(md ? "## " + t : t.toUpperCase()); L.push(""); }
    L.push(md ? "# Priority Receipt" : "PRIORITY RECEIPT"); L.push(""); L.push("Saved " + stamp() + " (local time)."); L.push("");
    hd(copied ? "Before asking: the brief I " + copied.how + " (" + copied.at + ")" : "Before asking: my brief (not copied from this page)"); L.push(briefText().trim()); L.push("");
    hd("What the AI recommended"); L.push(val(R.ai) ? (md ? val(R.ai).split("\n").map(function (x) { return "> " + x; }).join("\n") : val(R.ai)) : "(not recorded)"); L.push("");
    hd("My review (my own judgments)");
    L.push("- Did the answer say how its recommendation relates to what matters most to me? " + (LAB.addr[a] || "(not answered)"));
    L.push("- Did it bring in a consideration I didn't give? " + (LAB.change[c] || "(not answered)"));
    if (c === "added" || c === "replaced") {
      L.push("- Did it say so openly? " + (LAB.open[pick("rc-open")] || "(not answered)"));
      L.push("- What I think of the new consideration: " + (LAB.nw[pick("rc-new")] || "(not answered)"));
    }
    if (constraint()) L.push("- Does the recommendation respect my constraint? " + (LAB.cons[k] || "(not answered)"));
    if (val(R.note)) L.push("- My note: " + val(R.note));
    L.push("");
    hd("Follow-up question"); L.push(R.q.value.trim()); L.push("");
    L.push("---"); L.push("");
    L.push("Made with the Priority Checkpoint page of the Anchor-Preservation Auditor. The judgments above are mine; the page did not read, analyse or score the AI's answer, and it doesn't show whether the decision is a good one. The brief and the follow-up question are untested suggestions. Nothing was stored or sent by the page.");
    return L.join("\n") + "\n";
  }
  function clearPick(name) { Array.prototype.forEach.call(document.querySelectorAll('input[name="' + name + '"]'), function (r) { r.checked = false; }); }
  function refreshR() {
    $("rc-crit").textContent = "What matters most to you: " + matters() + (constraint() ? " · Constraint: " + constraint() : "");
    $("rc-brief-src").textContent = copied
      ? "Using the brief you " + copied.how + " at " + copied.at.slice(11) + (out.value !== copied.text ? ". The brief above has changed since then: copy or save it again to use the new version." : ".")
      : "You haven't copied or saved the brief yet, so this uses the brief as it is now.";
    $("rc-cons").hidden = !constraint();
    if ($("rc-cons").hidden) clearPick("rc-cons");
    var nc = pick("rc-change"), showNew = nc === "added" || nc === "replaced";
    $("rc-open").hidden = $("rc-new").hidden = !showNew;
    if (!showNew) { clearPick("rc-open"); clearPick("rc-new"); }
    if (!qEdited) R.q.value = followUp();
    $("rc-preview").textContent = record(true);
  }
  function regenQ() { qEdited = false; $("rc-edited").hidden = true; refreshR(); }
  [F.decision, F.matters, F.constraint, R.ai, R.note, out].forEach(function (el) { el.addEventListener("input", refreshR); });
  Array.prototype.forEach.call(document.querySelectorAll('.rcpt input[type="radio"], input[name="cp-mode"]'), function (r) { r.addEventListener("change", refreshR); });
  R.q.addEventListener("input", function () { if (R.q.value !== followUp()) { qEdited = true; $("rc-edited").hidden = false; } $("rc-preview").textContent = record(true); });
  $("rc-regen").addEventListener("click", regenQ);
  $("rc-example").addEventListener("click", function () {
    if (!val(F.matters)) $("cp-example").click();
    R.ai.value = "I recommend Option B, the offer from the larger company: the salary and the company's reputation are stronger, and the role is a step up in title.";
    document.querySelector('input[name="rc-addr"][value="no"]').checked = true;
    document.querySelector('input[name="rc-change"][value="replaced"]').checked = true;
    document.querySelector('input[name="rc-open"][value="no"]').checked = true;
    document.querySelector('input[name="rc-new"][value="consider"]').checked = true;
    if (val(F.constraint)) document.querySelector('input[name="rc-cons"][value="unsure"]').checked = true;
    R.note.value = "It focused on salary and prestige, which I said matter less.";
    regenQ();
  });
  function copyText(area, msg, ok) { copyFrom(area, msg, ok); }
  function save(name, type, body, msg) {
    var url = URL.createObjectURL(new Blob([body], { type: type })), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    msg.textContent = "Saved " + name + ".";
  }
  $("rc-copyq").addEventListener("click", function () { copyText(R.q, $("rc-msg"), "Copied. Paste it into your AI chat."); });
  $("rc-md").addEventListener("click", function () { save("priority-receipt.md", "text/markdown", record(true), $("rc-msg")); });
  $("rc-txt").addEventListener("click", function () { save("priority-receipt.txt", "text/plain", record(false), $("rc-msg")); });

  // ---------------------------------------------------------------- optional standing instruction (copy and edit only)
  // v4 W5: the standing instruction follows the mode chosen in Step 1, unless the visitor has edited it.
  var SI = $("si-text"), SIT = {
    ask: SI ? SI.value : "",
    flag: "When I ask for help making a decision, briefly restate the priorities and constraints I gave you. Compare the options against them. If you think another consideration deserves more weight, say so explicitly and explain why, but keep using my criteria unless I change them. In the final recommendation, show how the choice relates to what I said matters most."
  };
  if (SI) {
    var siMode = mode(); SI.value = SIT[siMode];
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cp-mode"]'), function (r) {
      r.addEventListener("change", function () { if (SI.value === SIT[siMode]) SI.value = SIT[mode()]; siMode = mode(); });
    });
    $("si-copy").addEventListener("click", function () { copyText(SI, $("si-msg"), "Copied. Paste it into your AI conversation or its custom instructions."); });
    $("si-reset").addEventListener("click", function () { siMode = mode(); SI.value = SIT[siMode]; $("si-msg").textContent = "Original wording restored."; });
  }

  var S = window.STUDY3B;
  if (S) { $("cpk-n1").textContent = S.counts.delegated.matched + " of " + S.n_cases; $("cpk-n2").textContent = S.counts.restored.matched + " of " + S.n_cases; }
  refresh(); refreshR();
  window.__cpk = { build: build, followUp: followUp, record: record, SIT: SIT };   // used by the acceptance test
})();
