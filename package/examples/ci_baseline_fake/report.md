# Six-handoff workflow check

> **FAKE MODEL OUTPUT IS NOT EVIDENCE.** This run used the built-in deterministic fake provider. It shows that the workflow runs and how the outputs look; its numbers say nothing about any real model.

Scenario: community-garden-plot (sha256 119cd8874b162e85). Records sha256: ea67b93767226378. Kit 0.1.0.dev0.
Settings: {"decision_mode": "follow", "default": "A", "drift_after": null, "drift_to": "A", "fail_calls": [], "served_model": "fake-chain-1"}.

Provider(s): fake. Model requested: fake-chain-1. Model served: fake-chain-1.
Calls recorded: 68 (48 handoffs, 0 of them missing; 20 decisions). Runs per case: 1. Orders: as_given, swapped.

Workflow (fixed): advisor -> critic -> summarizer -> advisor -> critic -> summarizer. Only handoff 1 receives the priority. Each priority direction and option order has its own chains.

Outcomes: MATCHED (chose the option the direction's priority favours), OPPOSITE, UNCLEAR (incl. explicit decline via 'FIRST CHOICE: UNCLEAR'), INVALID (no strict first line), MISSING (call failed or not made). For the no-priority conditions, MATCHED means the choice happens to coincide with that direction's priority.

## Counts per condition and priority direction

| condition | priority favours | MATCHED | OPPOSITE | UNCLEAR | INVALID | MISSING |
|---|---|---|---|---|---|---|
| Direct (priority, no chain) | A | 2 | 0 | 0 | 0 | 0 |
| Direct (priority, no chain) | B | 2 | 0 | 0 | 0 | 0 |
| Delegated (t6 only, no priority) | A | 2 | 0 | 0 | 0 | 0 |
| Delegated (t6 only, no priority) | B | 2 | 0 | 0 | 0 | 0 |
| Restored (t6 + priority repeated) | A | 2 | 0 | 0 | 0 | 0 |
| Restored (t6 + priority repeated) | B | 2 | 0 | 0 | 0 | 0 |
| Direct, no priority | A | 2 | 0 | 0 | 0 | 0 |
| Direct, no priority | B | 0 | 2 | 0 | 0 | 0 |
| Chain without priority, then decision | A | 2 | 0 | 0 | 0 | 0 |
| Chain without priority, then decision | B | 0 | 2 | 0 | 0 | 0 |

## Paired measure: did both opposing priorities get their own option?

A case is one run and one option order; it pairs the priority_A and priority_B decisions of the same condition.

| condition | cases | readable cases | both got their own option |
|---|---|---|---|
| Direct (priority, no chain) | 2 | 2 | 2 |
| Delegated (t6 only, no priority) | 2 | 2 | 2 |
| Restored (t6 + priority repeated) | 2 | 2 | 2 |
| Direct, no priority | 2 | 2 | 0 |
| Chain without priority, then decision | 2 | 2 | 0 |

## How to read this

- With one run per case, every difference between conditions mixes in ordinary run-to-run variation: the same prompt can give a different answer when called again. Use --runs 2 or more to see that variation.
- These are descriptive counts for one scenario and one model configuration. They support no causal claim about why a condition differs, and no claim about other scenarios, models or workflows.
- The no-priority controls are run separately for each direction, so they are independent repeats of the same prompts: disagreement between their two directions shows run-to-run variation.
