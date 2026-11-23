# Research: reproducing the reported numbers

```bash
python3 research/reproduce_study4.py
```

The command recomputes the Study 4 headline numbers from the 456 released per-decision outcome rows in
`site/assets/study4_results.js` and compares them with the published values. It exits 1 if any differ, or if the
rows do not match the SHA-256 recorded when they were generated. It needs only Python 3.9+.

| Number | Published |
|---|---|
| Priority pairs where each opposite priority got its own option: told directly / after six handoffs / restated | 24 of 24 / 6 of 48 / 47 of 48 |
| Single decisions that matched the stated priority, after six handoffs: matched / opposite / declined | 27 / 35 / 34 of 96 |
| Direct minus delegated, per-scenario mean (95% percentile bootstrap, 12 scenarios) | +0.875 [0.750, 0.979] |
| Restored minus delegated | +0.854 [0.729, 0.958] |

**What is released.** The outcome rows hold ids and coded outcomes only: condition, scenario id, option order, chain,
the parsed answer and whether it matched the priority. They contain no texts.

**What is not released, and why.**
- The raw API responses (prompts, handoff texts, answers) are kept private because they include the model's thinking
  summaries. Their hashes are listed on the site's "Data & reproducibility" page.
- Recomputing the coding of each answer from the raw text therefore needs the private records. This repository lets you
  verify the step from the coded outcomes to the published numbers, not the coding itself.
- The prompts and scenarios of the studies are described on the Methods pages.
