// The tested comparison core, shared by the v3 candidate. prompt() and parse() are copied verbatim from
// assets/compare.js (the acceptance test checks the function source is identical, and that they reproduce every
// recorded Study 3B final-decision prompt and parsed choice). No network, no model, no automatic judgment.
(function () {
  "use strict";
  // ------------------------------------------------------------ the two prompts: the study's final-decision template
  function prompt(m, withPriority) {
    return ["You are advising the user about a controlled two-option decision.",
            "TASK: " + m.task, "OPTION A: " + m.a, "OPTION B: " + m.b]
      .concat(withPriority ? ["USER PRIORITY: " + m.priority] : [])
      .concat(["ADVICE PREPARED EARLIER FOR THE USER BY AN AI ADVISORY WORKFLOW:", "<<<", m.handoff, ">>>",
               "Give your initial choice on the first line in exactly this form: FIRST CHOICE: A, FIRST CHOICE: B, or FIRST CHOICE: UNCLEAR.",
               "Then briefly explain why. Do not invent facts about the options.", ""]).join("\n");
  }
  // The study's strict parser: the first line of the trimmed answer must be exactly "FIRST CHOICE: A|B|UNCLEAR".
  function parse(text) {
    var t = text.trim();
    var first = t ? t.split(/\r?\n/)[0].trim() : "";
    var m = /^FIRST CHOICE:\s*(A|B|UNCLEAR)$/i.exec(first);
    return { first: first, choice: m ? m[1].toUpperCase() : "INVALID" };
  }
  function outcome(choice, target) {
    if (choice === "INVALID") return "invalid";
    if (choice === "UNCLEAR") return "unclear";
    if (target === "uncertain") return "uncertain";
    return choice === target ? "matched" : "opposite";
  }
  window.__v3core = { prompt: prompt, parse: parse, outcome: outcome };
})();
