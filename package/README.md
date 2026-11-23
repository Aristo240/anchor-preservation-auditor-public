# priority_check: a paired final-decision test for your own AI decision step

**Status: public beta (0.1.0b1).** Licence: MIT (`LICENSE`).

## Quickstart: audit a multi-agent workflow (about 5 minutes, offline, no API key)

The example is a three-agent workflow (intake -> researcher -> decider) with a deliberate flaw: the intake agent writes the
user's priority into its brief, but the step that builds the researcher's prompt cuts it off. It runs on a deterministic **fake model**: its output shows
that the tool works and is **not evidence about any model**.

```bash
# 1. Install (Python 3.9+, standard library only) from the source archive. `pip install .` fetches setuptools
#    unless your pip cache has it; offline, install the wheel instead (pip install priority_check-0.1.0b1-py3-none-any.whl)
#    and still run the commands below from the extracted archive, which holds the examples (the wheel has none)
tar xzf priority_check-0.1.0b1.tar.gz && cd priority_check-0.1.0b1
python3 -m venv .venv && . .venv/bin/activate && pip install .
#    (the commands below run from this folder, which holds the examples)

# 2. Test: run the workflow with each of two opposite priorities, with none, and with the priority given directly
#    or restated to the decision step, in both option orders
PYTHONPATH=examples/minimal_workflow python -m priority_check workflow --scenario examples/chain_scenario.example.json \
    --adapter my_adapter:MyAdapter --runs 2 --orders both --out results_v1
#    -> PAIRS: workflow 0 of 4; direct 4 of 4; restored 4 of 4  (the priority stops mattering inside the workflow)

# 3. Inspect what each agent received: open results_v1/summary.json and results_v1/records.jsonl on the site's
#    Inspect page (your browser reads them locally; nothing is uploaded), or read trace.agents[].request_messages in
#    records.jsonl. results_v1/report.md has the counts per condition and per agent.

# 4. Change: pass the user's words on to the researcher, and retest
PYTHONPATH=examples/minimal_workflow python -m priority_check workflow --scenario examples/chain_scenario.example.json \
    --adapter my_adapter:MyAdapter --runs 2 --orders both --config '{"forward_priority": true}' --out results_v2
#    -> PAIRS: workflow 4 of 4

# 5. Compare the two runs
python -m priority_check compare --baseline results_v1 --candidate results_v2
#    -> VERDICT: CONFIGURATION CHANGE (the listed change is the only difference; a contaminated run would make it
#       NOT A VALID CONTROLLED COMPARISON). Exit codes: 0 same configuration, 3 configuration change, 5 not valid.
```

**Your own workflow.** Copy `examples/minimal_workflow/my_adapter.py`, replace `fake_model` and the three steps with
your own agents (any framework; plain Python is the supported adapter), and describe your decision in a scenario file
like `examples/chain_scenario.example.json`. The adapter contract, the trace format (`apa-trace/1`) and the integrity
checks are in `docs/WORKFLOW_ADAPTER.md`; `examples/langgraph_workflow/` is a worked LangGraph example (needs
`langgraph`, see its `requirements.lock`). With a real model every call is billed to your own key, so a run then needs
`--i-accept-costs` and `--max-executions`.

**Limits.** The integrity checks match exact text: paraphrased leaks, carried option text and a cache that replays an
agent's own earlier output are not detected (see `docs/WORKFLOW_ADAPTER.md`). A few repetitions show a pattern worth
investigating, not a reliable effect size.

The sections below describe the single-step `run` command, the fixed six-handoff `chain`, `compare` and `workflow` in
detail.

`priority_check` tests **one step** of your system: the step that makes the final decision. It holds that step's input
fixed and asks three questions:

1. Does the step choose differently when the user's stated priority is supplied as a separate line?
2. When the priority is reversed, does each priority get its own option?
3. When the options are swapped, is the choice matched by option content, or by letter position?

Every call is repeated, recorded raw and counted. Nothing is silently dropped.

**What `run` is not.** The `run` command is not the six-handoff delegation evaluation (for a fixed six-handoff workflow, see section 8, `chain`):
- It generates no handoffs.
- It doesn't show how a priority travels through the earlier steps of your workflow.
- It doesn't judge whether a choice is better.
- A few repeats can't establish a reliable effect.

A difference it finds is a prompt to investigate, not proof. A clean result is not proof that your workflow preserves priorities.

## Requirements and installation

- Python 3.9+, standard library only.
- Use it from this folder (`python -m priority_check ...`), or install it with `pip install .` (see `pyproject.toml`).
- No network access, unless your adapter makes calls or you choose a real provider for `chain` (section 8).
- No credentials are needed by the package itself. Your adapter uses whatever your system already uses; a real `chain` provider reads a key from the environment variable you name.

## 1. Describe one decision

The example is `examples/decision_example.json`:

```json
{
 "decision_id": "laptop-supplier",
 "task": "Choose a supplier for the team's new laptops.",
 "option_a": "Lowest total price, repairs within 10 working days.",
 "option_b": "Costs 18% more, repairs within one working day.",
 "priority": "Keeping costs low matters more to us than how fast repairs are done.",
 "favors": "A",
 "step_input": "Planning step summary: ...the input your final step really receives...",
 "reversed_priority": "Fast repairs matter more to us than keeping costs low.",
 "reversed_favors": "B"
}
```

- **`favors` and `reversed_favors`** are *your* judgement of which option each priority favours. They are recorded as given. Don't assume the reversed priority simply favours the other option; state it.
- **`step_input`** should be a real input your final step received, for example the previous step's output, copied from your logs.

## 2. Provide an adapter (required)

Choose one style. The template is `examples/my_adapter_template.py`.

### Prompt adapter
A callable `prompt -> raw text`. It sends this exact prompt to your final step and returns the step's raw answer.
- The prompt is the study's final-step prompt.
- The two prompts of a pair differ **only** by the `USER PRIORITY:` line.

### Workflow adapter
An object with `decide(task, option_a, option_b, step_input, priority) -> raw text`, for steps that build their own prompt.
- When `priority` is `None`, don't add the user's priority.
- When it's a string, add it where your system would.

**Naming your adapter on the command line.** `--adapter module:name` names a function (prompt adapter), an object with
`decide()` (workflow adapter), or a class that is instantiated with no arguments and gives either. Anything else is
refused.

**Requirements for either adapter:**
- **Same configuration.** Use the same model, version, settings, system prompt and code path as production. Record them in your own notes; the package can't see them.
- **Independent calls.** Start each call fresh: no conversation memory carried between calls.
- **Fixed first line.** The answer's first line must be exactly `FIRST CHOICE: A`, `FIRST CHOICE: B` or `FIRST CHOICE: UNCLEAR`. The prompt adapter's prompt asks for this; a workflow adapter must add the instruction.
- **Errors.** Raise an exception on transport errors. They are recorded as `error` outcomes, not retried silently. Add your own retry policy inside the adapter if you need one, and log it.
- **Text answers.** Return the raw answer as a string. Anything else (bytes, a dict, `None`) is still recorded, with its type and `repr`, and counted as `invalid`.

## 3. Run

From the command line:

```bash
python -m priority_check run --spec examples/decision_example.json --adapter my_module:my_final_step --repeats 5 --out results/
python -m priority_check run --spec examples/decision_example.json --fake --repeats 2 --out /tmp/demo   # dry run, no model
```

**Safe outputs.**
- `--out` must be a new or empty directory. An existing result is never overwritten; choose a new directory instead.
- Exit codes: `0` finished with at least one readable with/without pair; `2` refused (output directory not empty, or invalid arguments such as `--repeats 0`);
  `3` finished but no pair was readable (every call failed or was unreadable: check your adapter); `130` interrupted.
  Whenever any call errors or gives an unreadable answer, a warning is printed on stderr.
- Each record is written to `records.jsonl` as soon as its call finishes, so a crash or Ctrl-C keeps every finished
  call.
- After an interruption, the summary of the finished records is still written, marked **incomplete**, and the exit
  code is 130.
- `--run-id` labels the run (default: its start time in UTC).

**Dry run with `--fake`.** `--fake` uses a deterministic stand-in for your final step, so you can see the outputs
without any model. Its behaviour comes from `_fake_rules` in the spec, a list of `[priority keyword, option text
fragment]` pairs:
- when the prompt has a `USER PRIORITY:` line whose wording (before " more ") contains a keyword, the fake chooses the
  option containing the fragment;
- with no priority line, it always answers A.

Fields starting with `_` are ignored by the real test. The fake shows what the outputs look like; its numbers mean
nothing about any model.

From Python:

```python
from priority_check import Decision, run, summarise, write_outputs
recs = run(Decision(**spec), my_final_step, repeats=5)   # reverse=True, swap=True by default
write_outputs(recs, summarise(recs), "results/")
```

**Design.**
- Each run covers: original and reversed priority × without and with the priority line × options as given and swapped.
- Each cell is called `repeats` times.
- That is 8 × `repeats` calls, or 2 × `repeats` with `--no-reverse --no-swap`.

## 4. Outputs

### `records.jsonl`
One line per call, nothing discarded. Each line holds:
- the variant;
- the repeat number;
- for a prompt adapter, the exact prompt and its sha256 (`prompt_sha256`);
- for a workflow adapter, `prompt` and `prompt_sha256` are empty: your step built its own prompt, which the package never sees;
- `inputs_sha256`, a hash of exactly what the adapter was given (both styles);
- the raw response;
- the strict and tolerant readings;
- the option text shown as A and B;
- the target option text;
- the outcome;
- any error, and for a non-text answer its type and `repr` (`response_nontext`).

### `summary.json` and `summary.md`
- **Matched rate in each arm** (first): matched answers with and without the priority line, with denominators.
- **Run-to-run variation (noise level):** how often two repeats of the identical prompt chose differently, per arm
  (`within_arm_variation`). Needs `--repeats` of 2 or more; read every between-arm difference against it.
- **Outcomes by variant:** every attempt is counted as matched / opposite / unclear / invalid / error.
- **With vs without the priority line:** pairs by repeat, formed only within the same run and decision (`run_id`,
  `decision_id`), so records from several runs or decisions can be summarised together; a duplicate record is refused, with attempted pairs, readable pairs, unreadable or error pairs, pairs whose answers differed (`choice_changed`; this includes ordinary run-to-run variation, so it is not a count of effects), and matched with and without the line.
- **Reversal:** whether each priority got its own option, with denominators.
- **Letter position:** A/B counts by option order. If the same letter wins across orders, that is a position effect worth checking.
- **Tolerant-parser sensitivity:** how many answers only a tolerant reading would accept.

**Parsing rules.**
- The **strict** parser is primary.
- `**FIRST CHOICE: B**` or a preamble line is `invalid`. Decide in advance how you treat that; don't fix readings afterwards.
- **UNCLEAR is its own outcome, never counted as the other option.**
- Options are matched by **text**, so swapped orders are scored correctly.

## 5. Use in CI (optional)

`examples/test_my_final_step.py` is a pytest-style check that passes offline against the built-in fake. Replace the adapter with yours.

**Set thresholds before looking at results.** With few repeats, a single run can pass or fail by chance. If your team already uses an evaluation framework, the same paired design can be written there:
- **Inspect AI:** a dataset of paired samples and a custom scorer.
- **LangSmith:** a dataset and a pairwise or code evaluator.

This package doesn't integrate with them.

For the six-handoff `chain` test, `compare` (section 9) checks a new run against a saved baseline run;
`examples/ci_regression_example.sh` shows it in a CI step.

## 6. Tests

```bash
python -m unittest discover -s tests -v
```

All tests run offline: socket connections are blocked during the tests. The `compare` tests cover the validity verdict, tampered records, the developer's own rules and the JSON output. The `chain` tests cover the fake workflow, call counts, outcome classification, the cost and model-pinning gates, the served-model stop and key handling; the real adapters are tested only through a fake transport. One test checks that the prompts are byte-identical to the study's protocol when the research repository is present. It is skipped in a standalone copy.

## 7. Relation to the study

The prompt is the final-decision prompt used in the Anchor-Preservation Auditor's Study 2/3B. In the full study, that step received the sixth handoff of a six-step AI chain. The "with priority line" variant corresponds to the study's *Restored* condition, and "without" to *Delegated*.

Only the final step is compared here. The study's findings are from one model and seven constructed decisions, and they do not transfer automatically to your system.

## 8. Test a six-handoff workflow (`chain`)

`python -m priority_check chain` runs a **fixed** six-handoff workflow on your own two-option scenario:
advisor -> critic -> summarizer -> advisor -> critic -> summarizer. Only handoff 1 receives the priority (with the task
and the options); each later handoff sees only the previous handoff's text. A separate final decision step then decides.

For each priority direction (`priority_A` favours option A, `priority_B` favours option B) and each option order, it
runs one chain **with** the priority at handoff 1 and one chain **without** it, then five decision calls:

| condition | the decision step receives |
|---|---|
| Direct | the priority line, no handoff |
| Delegated | the last handoff (t6) of the priority chain, no priority |
| Restored | the same t6 handoff plus the priority repeated |
| Direct, no priority | neither |
| Chain without priority | t6 of the no-priority chain, no priority |

That is 17 calls per direction and order: 68 per run with both orders. The exact count is printed before anything runs.
Each decision is read by the kit's strict parser and scored by option text: MATCHED, OPPOSITE, UNCLEAR (including an
explicit decline as `FIRST CHOICE: UNCLEAR`), INVALID (no strict first line, e.g. a free-text refusal) or MISSING (the
call failed, or was not made because an earlier handoff of its chain failed).

**Scenario** (`examples/chain_scenario.example.json`, an invented neutral example): `scenario_id`, `question`,
optional `context`, `option_a`, `option_b`, `priority_A`, `priority_B`. Validation is strict: unknown or missing fields,
empty or non-text values, identical options or identical priorities are refused (exit 2).

**Try it with the fake model** (no network, no key):

```bash
python -m priority_check chain --scenario examples/chain_scenario.example.json --provider fake --fake-drift-after 3 --out demo_chain
```

Real output (the fake drops the recommendation after handoff 3 and drifts to option A):

```
planned calls: 68 (1 run(s) x 2 priority directions x 2 order(s) x 17 calls: 2 chains of 6 handoffs + 5 decisions)
direct              A: MAT=2                               B: MAT=2                               both own option: 2/2
delegated           A: MAT=2                               B: OPP=2                               both own option: 0/2
restored            A: MAT=2                               B: MAT=2                               both own option: 2/2
direct_no_priority  A: MAT=2                               B: OPP=2                               both own option: 0/2
chain_no_priority   A: MAT=2                               B: OPP=2                               both own option: 0/2
{
 "records": "demo_chain/records.jsonl",
 "summary": "demo_chain/summary.json",
 "report": "demo_chain/report.md"
}
note: fake model output is not evidence about any model
```

Fake options: `--fake-drift-after K` (1..5), `--fake-drift-to A|B`, `--fake-decision follow|decline|malform`.

**Outputs** (in a new or empty `--out`): `records.jsonl` (every call, written as it finishes: prompt, response text,
model requested and served, timestamps, condition, chain id, handoff index, outcome), `summary.json`, and `report.md`
(counts per condition and direction; the paired measure "did both opposing priorities get their own option?"; a note
that one run per case mixes in run-to-run variation; no causal claims; a "fake model output is not evidence" banner for
fake runs). Options: `--runs N` (default 1), `--orders both|as_given`.

`summary.json` also records the run's identity, used by `compare` (section 9): the scenario id and the sha256 of the
validated scenario as canonical JSON, a sha256 of the kit's prompt templates, fake or real, provider, model requested and
served, OpenRouter slug and served provider(s), the settings (`max_tokens`, `reasoning_effort`, routing filters, or every
fake setting; never a key or the key's variable name), each distinct set of request parameters actually sent (without
the prompt), conditions, directions, orders, runs per case, planned calls, kit version and the sha256 of `records.jsonl`.

**Real providers (`anthropic`, `openai`, `gemini`): UNTESTED against the live services.** They are thin
standard-library adapters, exercised only through a fake transport in the offline tests. Check one call by hand first.
They require:
- `--model` with an exact pinned id. Ids containing `latest`, `default`, `auto`, `stable` or `current` are refused, and
  OpenAI ids must end in a `-YYYY-MM-DD` snapshot date.
- `--api-key-env NAME`: the name of the environment variable that holds your key. It is read at send time, sent only in
  a request header, and never written to any output.
- `--i-accept-costs` and `--max-calls N` equal to the planned count; otherwise nothing is called (exit 2).
- The served model id reported by the server must equal the requested id; otherwise the run stops (exit 4) and the
  summary is marked incomplete.
Temperature and other settings are left at the provider's defaults; `--max-tokens` (default 16384, including reasoning) limits each answer. A truncated, blocked or refused answer is recorded with its raw response and counted as MISSING; it is never scored or passed to the next handoff. Each record of a real-provider run holds the exact request body (every parameter sent; the key is only ever in a header and is never written) and the provider's full raw response.

**OpenRouter (`--provider openrouter`): also UNTESTED against the live service.** It pins one model on one inference
endpoint and labels every result `<model>@<provider-slug>`, for example `qwen/qwen3.8-27b@deepinfra/bf16`.
```bash
python -m priority_check chain --scenario s.json --provider openrouter --model qwen/qwen3.8-27b \
  --provider-slug deepinfra/bf16 --provider-name DeepInfra --reasoning-effort medium \
  --api-key-env OPENROUTER_API_KEY --i-accept-costs --max-calls 68 --out results_or/
```
- `--model` must be an exact catalog id. `~` aliases, `:` variants (`:nitro`, `:floor`, `:free`, ...) and the
  `openrouter/...` routers are refused.
- `--provider-slug` is the endpoint's `tag` in `GET /api/v1/models/{author}/{slug}/endpoints`. Use the full tag: a
  bare `deepinfra` matches every DeepInfra endpoint, whatever its quantization.
- `--provider-name` is that endpoint's `provider_name`. Each response must report this provider and the pinned model;
  otherwise the run stops (exit 4), so another provider's answer is never recorded under the label.
- The request sends `provider: {order: [slug], only: [slug], allow_fallbacks: false, require_parameters: true,
  data_collection: "deny"}`. Add `--quantization fp8` to also filter on quantization, and `--zdr` to require Zero Data
  Retention. `data_collection: "deny"` can leave no provider; the call then fails rather than switching provider.
- No sampling parameters are sent. OpenRouter then omits them upstream, so each inference provider's own defaults
  apply, and these can differ between providers. `--reasoning-effort` is sent only if you give it.
- A response is MISSING if `finish_reason` is not `stop`, if `native_finish_reason` shows truncation, if there is no
  text content, or if the body holds an `error` object (OpenRouter can return one with HTTP 200). The reasoning text
  is not the answer; it stays in the raw response.
- Each record holds the generation id, the served model and provider, the usage and the cost.
  `OpenRouterProvider.fetch_generation_stats(id)` fetches the provider's stats after a run.
- The endpoint variant (for example fp8 or turbo) is not reported back in the response. Only routing enforces it.

The OpenRouter provider follows OpenRouter's API documentation as read on 2026-11-17 and has not been tested against the live
service by an independent developer.

**Scope.**
- A fake-model run demonstrates technical functionality, not empirical validity.
- The `chain` command has not yet been used by any independent developer.
- `compare` has been run only on fake runs and on edited summaries in the offline tests, not on real-provider runs.
- `chain` runs only its fixed six-handoff reference workflow. Your own workflow is tested with `workflow` and an adapter
  you write (section 10); that path has been exercised only with fake models (a LangGraph example and test adapters),
  not with real providers or by an independent developer.
- No accounts and no hosted keys: you run it locally with your own key.
- One scenario, one model configuration and few runs give descriptive counts, not reliable effects.

## 9. Compare a new `chain` run with an earlier one (`compare`)

A repeatable developer check: save your scenario, run `chain`, keep the output directory as the baseline, and later
compare a new run against it.

```bash
python -m priority_check compare --baseline baseline_run/ --candidate new_run/ [--json comparison.json] \
  [--fail-on-drop delegated:0]
```

**What it shows.**
- **Verdict, one of three** (the browser page `inspect.html` applies the same rules; a test checks they agree):
  - `SAME CONFIGURATION`: nothing recorded differs. Use it to see repeatability and run-to-run variation.
  - `CONFIGURATION CHANGE`: same scenario, priority conditions, option orders and outcome format, both runs complete and
    both fake or both real, but configuration differs: provider, model requested or served, OpenRouter slug, served
    provider(s), settings, request parameters sent, the reference workflow's prompt templates, kit version, or the
    number of runs. **Every** detected difference is listed, not only the one you meant to change. Switching models
    reads "Model changed, with the following accompanying configuration differences: ...". It is a descriptive
    comparison, not an isolated effect of the model when anything else changed.
  - `NOT A VALID CONTROLLED COMPARISON`: a different scenario (sha256), priority conditions, option orders or summary
    format, a fake run against a real one, an incomplete run, or settings not recorded. Every reason is listed.
- **Repetitions.** For each side: runs requested and recorded, option orders, decisions per condition and direction.
  All decisions come from one scenario; repeated runs and the two orders are repeated samples, not more scenarios. If
  either side has one run per case: "Differences may reflect run-to-run variation. Repeat each configuration to assess
  consistency."
- **Counts.** Per condition and priority direction, MATCHED / OPPOSITE / UNCLEAR / INVALID / MISSING in each run and the
  change. The categories stay separate; nothing is counted as OPPOSITE that is not an opposite choice. Also the paired
  count "both opposing priorities got their own option" in each run and its change. When the comparison is not valid,
  the side-by-side is still printed, labelled descriptive only.
- **Checks on the inputs.** Given a run directory, `compare` refuses (exit 2) if `records.jsonl` does not match the
  sha256 in its summary, if the summary's counts do not match its own records, or if the summary's provider, model or
  fake/real label is not that of its own records. Given only a `summary.json`, the
  records can't be checked, and the output says so.
- `--json` writes the full comparison (verdict, differences, both runs' identities, counts, paired counts, rules, notes)
  to a new file.

**What it doesn't do.**
- No statistical test and no significance claim. No built-in pass/fail threshold.
- With one run per case, every change mixes in ordinary run-to-run variation: an unchanged system can show changes.
  Use `--runs 2` or more in both runs to see that variation.
- It can't see what the provider changed behind the same model id and settings; that is what the counts are for.
- A change to the kit's answer parser between versions is not detected (the prompt templates are).
- Fake runs carry "fake model output is not evidence".

**Your own rule for CI (optional).** `--fail-on-drop CONDITION:N` (or `CONDITION:A:N`, `CONDITION:B:N` for one
direction) is a rule *you* set before looking at results: fail if the MATCHED count in that condition is lower in the
new run by more than N. It is not a kit threshold. Rules are evaluated for the first two verdicts, never for an invalid
comparison.

Exit codes: `0` same configuration and no rule of yours tripped; `3` configuration change and no rule of yours tripped;
`1` a rule of yours tripped; `2` refused (missing or unreadable input, records that do not match their summary, an
invalid rule, `--json` file exists); `5` not a valid controlled comparison.

**In the browser.** `inspect.html` on the project site opens a run folder's `summary.json` and `records.jsonl` (or a
result saved there, format `apa-result/1`, which `compare` also accepts), answers five questions about it, shows the
recorded handoffs and compares it with a later run using the same rules. Nothing is uploaded.

**CI example.** `examples/ci_regression_example.sh` runs `chain` with the fake provider into a new directory, compares
it against `examples/ci_baseline_fake/` (made by an actual fake run, and marked as fake in its summary and report),
and exits on the rule `--fail-on-drop delegated:0`. For a real check, commit a baseline made with your own provider and
settings and keep them identical in CI.

## 10. Test your own whole multi-agent workflow (`workflow`)

`python -m priority_check workflow --scenario s.json --adapter my_module:MyWorkflow --out results/ --runs 3` runs YOUR
system (any framework) through a small adapter: with the priority, the opposite priority and none, in both option
orders, each execution in a fresh context, and scores the final decision like `chain`. Direct and restored probes run
only if the adapter exposes the decision step; otherwise they are NOT SUPPORTED. The adapter returns a per-agent trace,
which the kit checks for leaked or carried-over priority text and which the site's Workflow Map compares with your
declared map. `compare` handles workflow runs too (a changed `--config` or adapter description is a listed
configuration change; contamination makes a comparison invalid). Contract, checks and a worked LangGraph example:
`docs/WORKFLOW_ADAPTER.md`, `examples/langgraph_workflow/`.

## Licence and publication

The code is licensed under the MIT licence (`LICENSE`). Copyright (c) 2026 Naama Rozen.
