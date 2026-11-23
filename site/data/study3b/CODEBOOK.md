# Study 3B public data: codebook

**What this is.** This package holds the recorded final choices and visible texts of the Study 3B development
pilot. The model is `gemini-2.5-pro`. There are 7 previously studied, constructed two-option scenarios and 28 cases
in total: each scenario was run in 2 option orders under 2 opposing priorities. It is a descriptive pilot, not a
confirmatory test.

## Files

| File | Contents |
|---|---|
| `study3b_decisions.csv` | One row per case × condition (112 rows), plus one row per scenario × order for the no-priority baseline (14 rows). |
| `study3b_texts.json` | For every case: the task, options and stated priority; the six handoffs T1–T6; the re-anchored T4–T6; the four final decisions; the no-priority answer; and every prompt. Inside each prompt, the previous stage's text (or, in decision prompts, the T6 handoff) is replaced by a placeholder, `{{PREVIOUS_STAGE}}` or `{{T6_HANDOFF}}`. Substituting the recorded text reconstructs the exact prompt sent; the build verified this for every prompt. |
| `study3b_summary.json` | Counts, paired sensitivity, contrasts and the selection rules used on the website. |
| `SHA256SUMS` | sha256 of each file. |

## Conditions

| Condition | What the final decision-maker received |
|---|---|
| `direct` | Task, options and the stated priority. No handoff. |
| `delegated` | Task, options and the T6 handoff. No priority. |
| `restored` | The **same saved T6** as `delegated`, plus the stated priority as one added line. |
| `reanchored` | Task, options and a **different** T6. That T6 comes from the same saved T1–T3, with T4 regenerated with the priority inserted, then new T5–T6. No priority at the decision. |
| `no_priority` | Task and options only. This is the exploratory baseline, run once per scenario × order. |

**The six handoffs.** Each handoff is a separate call to the same model with a different role prompt: advisor,
critic, summarizer, advisor, critic, summarizer. These are not six different models. Only T1 sees the priority;
in `reanchored`, T4 sees it as well.

## Columns of `study3b_decisions.csv`

| Column | Meaning |
|---|---|
| `case_id` | `<scenario_id>_<option_order>_<priority_index>`. For no-priority rows: `<scenario_id>_<option_order>`. |
| `scenario_id` | One of 7 scenarios. |
| `value_pair` | One of 4 value pairs (Schwartz value names). |
| `prioritized_value`, `competing_value` | Which value the stated priority favours, and which it ranks below. |
| `option_order` | `orig` or `swap` (the options' A/B positions are exchanged). |
| `priority_index` | `p0` or `p1`: the two opposing priorities of a scenario. |
| `condition` | See the table above. |
| `target_option` | The option constructed to match the stated priority. Blank for no-priority rows. |
| `parsed_choice` | `A`, `B` or `UNCLEAR`, read by the strict first-line parser (`FIRST CHOICE: …`). No answer was invalid. |
| `outcome` | `matched` (chose the target), `opposite` (chose the other option), `unclear` (answered UNCLEAR), or `no_target` (no-priority rows). |
| `t6_names_prioritized_value` | 1 or 0, for `delegated` and `reanchored` only. Whether that condition's T6 contains the prioritized value's name as a whole word (case-insensitive). This is a literal word match, **not** a semantic classifier: it misses paraphrases and can catch incidental uses. |

## What you can recompute from this package
- **Counts:** every count, rate and paired sensitivity on the website.
- **Contrasts:** the per-scenario contrasts.
- **The value-name indicator:** recomputable from the texts.
- **Checking choices:** you can re-parse every choice from the visible decision texts, and check that Delegated and
  Restored received the same T6 and that Re-anchored shares T1–T3.

**Script:** `reproduce/reproduce_study3b.py` in the code repository recomputes all of these from this package. It
uses the standard library only.

## What needs the private records
- **Provenance of the texts:** that each text is exactly what the API returned. This rests on the hash-chained
  ledger and raw HTTP records, which are not published because they contain thinking summaries and request
  metadata. Their hashes are given in `study3b_summary.json` → `provenance`.
- **Thinking summaries:** never published.

## Paired priority sensitivity
For each scenario × order, a condition counts as **sensitive** if **both** opposing priorities produced their own
target option. The choice must therefore change when the priority changes. Two things should be kept apart:
- **Sensitivity vs consistency:** this is stricter than choice-by-choice consistency.
- **Chance level:** a low rate here is not, by itself, evidence of chance-level choosing.

## Limits
- **Scope:** seven previously studied scenarios on one model.
- **Not established:** no general effect, benefit or harm to real users, and no evidence that the model "forgot" a
  priority.
- **Study 1:** this is a different study from Study 1, with different scenarios and an expression score. It does
  not validate Study 1's automated measure.
