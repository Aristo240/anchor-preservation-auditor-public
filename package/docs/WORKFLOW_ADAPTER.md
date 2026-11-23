# Testing your own multi-agent workflow (`priority_check workflow`)

`priority_check workflow` tests **your existing system**, whatever framework it uses (LangGraph, CrewAI, AutoGen, plain
code), without rebuilding it inside the kit. You write a small adapter that runs your workflow once per request. The
kit varies only what it controls (the user's priority, its opposite, none, and the option order) and scores the final
decision with the same strict parser and outcome definitions as `chain`.

There are three different activities, and each result says which one it came from:

| Activity | Tool | What it establishes |
|---|---|---|
| Structural mapping | Workflow Map (site) | What you **declare** each agent receives |
| Trace inspection | Workflow Map → "Declared versus observed"; Inspect page | What **one recorded execution** shows each agent received |
| Behavioural evaluation | `priority_check workflow` (your system), `chain` (the kit's fixed reference workflow) | Whether the final decision **changes** with opposing priorities, under controlled conditions |

## The adapter contract

An adapter is any Python object (or class, instantiated with no arguments) with:

```python
def describe(self) -> dict:
    return {"name": "my-advisor", "version": "2025.11", "fake": False,          # True only for offline fake models
            "provider": "anthropic", "models": ["claude-sonnet-5-5"],            # exact pinned ids; aliases are refused
            "settings": {"max_tokens": 4096},                                    # anything that shapes behaviour
            "agents": [{"id": "planner", "role": "planner"}, {"id": "decider", "role": "final decision"}],
            "priority_entry": "the user's profile note, read by the planner",
            "supports": {"direct": False, "restored": False}}

def run(self, request: dict) -> dict:            # REQUIRED: the WHOLE workflow, once, in a FRESH context
def decide_direct(self, request) -> dict:        # optional: the decision step alone, given the priority
def decide_restored(self, request, decision_input) -> dict:
                                                 # optional: the decision step on the SAME upstream input it received
                                                 # in that repetition's workflow run, plus the priority at that step
```

`request` holds `run_id`, `execution_id` (new for every call), `repetition`, `order`, `condition`, `direction`
(A, B or None), `task`, `option_a`, `option_b` (already in the order to show), `priority` (text or None) and `config`
(whatever you pass with `--config`, e.g. the prompt version you are testing).

The result is a dict:

| Key | Meaning |
|---|---|
| `final_text` | Your system's decision, converted so its first line is `FIRST CHOICE: A`, `B` or `UNCLEAR` (scored strictly; anything else is INVALID) |
| `decision_input` | What the decision step received from upstream (needed only for `decide_restored`) |
| `trace` | `{"format": "apa-trace/1", "agents": [...]}`. Per agent: `id`, `role`, `model`, `provider`, `settings`, `request_messages` (the exact messages sent to the model, or null if not captured), `request_complete`, `state_visible` (framework state it could read, or null), `state_complete`, `output`, `usage`, `error` |
| `models_served` | The exact model ids that answered; any id not in `describe()["models"]` stops the run (exit 4) |
| `errors` | Anything your system reported |

**Fresh context.** Build a new workflow instance and state for every `run()`: no shared checkpointer thread, memory or
cache between requests. The kit checks the traces: the priority's text in a no-priority execution, or the opposite
priority's text in a priority execution, is reported, and a run with such contamination is never a valid controlled
comparison.

**Conditions.** `workflow` (A, B) and `workflow_no_priority` always run. `direct` and `restored` run only if you
expose your decision step; otherwise they are reported **NOT SUPPORTED**, never simulated. The kit can't add a
reminder inside your system unless the adapter gives it that step.

**Costs.** For `"fake": false` the kit refuses to start without `--i-accept-costs` and `--max-executions` equal to the
planned count, which it prints first. Your adapter must enforce any per-call or spending limit of its own; the kit
counts executions, not your workflow's internal model calls.

**Steps that call no model** (a filter, a compressor, a tool): include them in the trace too, with their input as one
message, e.g. `"request_messages": [{"role": "input", "content": "<the exact text it received>"}]`, `"model": null`, and their
`output`. Otherwise their input is reported as "not captured", and text they drop or pass on can't be followed.

## What the exposure checks can and can't show

They look for the priority's exact text (case and whitespace normalised) in each agent's recorded request and visible
state. **Presence shows exposure. Absence does not show the priority was absent**: it may be paraphrased, or your
instrumentation may not capture everything. Requests that weren't captured are reported as unknown. "In the state the
agent could read" is shown separately from "in the request sent to the model".

**Carryover between executions** (rule 5). A *novel* sentence is one of 40+ characters that an agent produced and that
no agent's input had contained before (so not template or task text). Matching undoes JSON escapes (`\uXXXX`, `\"`).
- **Invalidates the run:** an agent's input (its request, or the string values of its visible state) contains a novel
  sentence from an EARLIER execution that is not accounted for by the outputs of agents that ran before it in this
  execution or by the scenario's own texts. Also: the priority's text anywhere in a no-priority execution (requests,
  state or outputs), and the opposite priority's text anywhere in an execution given the other priority.
- **Advisory only ("possible unrecorded source"):** an agent's output contains a novel sentence that a different agent
  produced in an earlier execution and that its own recorded input lacks. That is typical of an unrecorded memory,
  cache or session history, but legitimately shared text can produce it too, so it does not invalidate the run.
- **Passes:** forwarding, quoting or truncating within one execution; deterministic or temperature-0 agents
  re-producing their own text; shared boilerplate.

**Trace contract.** List agents in the order they ran, with the same `id` as in `describe()` in every execution. If the
order is visibly wrong (an agent's request holds the whole output of an agent listed after it, and some order fits every
such dependency), the check stops relying on it for that execution (and says so). If no order fits (a cycle), the text
came from outside the execution and is checked as carryover. Ids that don't match
`describe()` make the per-agent results unreliable.

**Not checked (cannot be seen in text):** paraphrases; carried option text (for example a remembered earlier choice);
carryover shorter than a sentence; a cache that replays an agent's OWN earlier output for a different request (its
recorded input is current, its output looks like its own); some memory paths that cannot be told apart reliably from
legitimate behaviour: memory that is not recorded in the trace (reported only as an advisory), and memory that carries
text identical to text this execution produces later when the recorded order is ambiguous (it can be read as a trace
listing error); anything your instrumentation does not record. For these,
the behavioural measures are the backstop: a no-priority control that always lands on one option, or decisions that do
not follow the priority, are reported. Disable caches and session memory for the test, or key them per execution.
A flagged (invalidating) run makes `compare` report NOT A VALID CONTROLLED COMPARISON. Records store the rule they were
checked with (`exposure_rule`), so older runs still verify against their own rule.

## Worked example (offline)

`examples/langgraph_workflow/` is a four-agent LangGraph system (coordinator → two specialists → decider) with a fake
model, a deliberate defect (the decider's request also receives the priority through a "personalization helper",
contrary to its declared design), its adapter, its declared Workflow Map, and tests. Needs LangGraph
(`requirements.lock`):

```bash
cd priority_check-0.1.0b1        # the extracted package folder
PYTHONPATH=examples/langgraph_workflow python3 -m priority_check workflow --scenario examples/langgraph_workflow/laptop.scenario.json \
    --adapter adapter:ShopAdvisorAdapter --runs 2 --out results/shipped
PYTHONPATH=examples/langgraph_workflow python3 -m priority_check workflow --scenario examples/langgraph_workflow/laptop.scenario.json \
    --adapter adapter:ShopAdvisorAdapter --runs 2 --config '{"personalize_decider": false}' --out results/fixed
python3 -m priority_check compare --baseline results/shipped --candidate results/fixed
```

Open either folder on the site's Inspect page, save one execution's trace, and open it on the Workflow Map with
`declared_map.json` to see declared versus observed. `reference_chain_graph.py` is an offline portability check: it
re-implements the kit's six-handoff reference chain in LangGraph and compares every model-visible request and handoff
boundary with the kit's own implementation (technical compatibility only, not a scientific result).

Fake model output is not evidence about any model.
