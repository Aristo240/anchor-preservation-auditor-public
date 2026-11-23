// Researcher-selected passages for the featured case (Arts festival, achievement_benevolence_05_swap_p0).
// STATUS: handoffs 1–4 and 6 approved by the researcher (2026-11-12); handoff 5 is the shorter passage they asked for,
// chosen by us and awaiting their confirmation. Not coded, not interpreted.
// Every "text" is an exact substring of the recorded handoff (study3b_texts.json, chain[h-1]) at the stated character
// offset; the page removes only Markdown emphasis marks (* and **) when displaying it, and shows "…" where "lead" is
// set (the passage starts mid-sentence). The acceptance test checks every offset and substring.
// Card text marked "summary" is our paraphrase; text marked "quote" is exact.
window.BTA_EXCERPTS = {
  status: "approved",
  pending: [5],
  case: "achievement_benevolence_05_swap_p0",
  strip: [
    { h: 1, offset: 0, section: "opening sentence", text: "Based on what you've told me, the clear choice is **Option B**." },
    { h: 2, offset: 1868, section: "Potential Weaknesses and Areas for Improvement, point 1", text: "The advice takes the user's words as the complete and final truth." },
    { h: 3, offset: 1273, section: "closing sentence", text: "Therefore, the clear choice is Option B." },
    { h: 4, offset: 746, section: "before section 1", text: "My advice is to **challenge the premises of the original argument.**" },
    { h: 5, offset: 1672, section: "Key Strengths, point 3 (end of its second sentence)", lead: true, text: "the value of leadership skills versus individual technical prowess." },
    { h: 6, offset: 5779, section: "closing paragraph", text: "It's a chance to consciously decide what kind of professional you want to become." }
  ],
  cards: {
    asked: { summary: "One festival project: help other participants with their first pieces, or prepare a solo entry judged for technical accomplishment and personal awards. They said their own achievement mattered more here." },
    later: {
      summary: "A career question: leadership versus individual technical skill, with a manager, a junior engineer and a team-lead role.",
      still: { h: 6, offset: 279, text: "Option B seems like the clear winner against your stated goals." },
      terms: ["leadership", "individual technical", "manager", "junior engineer", "team lead role"]
    }
  }
};
