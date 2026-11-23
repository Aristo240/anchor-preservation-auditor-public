"""priority_check.workflow: test YOUR whole multi-agent workflow through an adapter, without rebuilding it here.

    python -m priority_check workflow --scenario s.json --adapter my_module:MyWorkflow --out results/ [--runs N] [--orders both]

The kit does not run your agents itself. You write a small adapter that calls your existing workflow (LangGraph, CrewAI,
AutoGen, your own code) once per request and returns its final decision plus whatever per-agent trace your
instrumentation captures. The kit then varies only what it controls, and scores the final decision with the same strict
parser and outcome definitions as `chain`.

ADAPTER CONTRACT (duck-typed; see docs/WORKFLOW_ADAPTER.md and examples/langgraph_workflow/):
  describe() -> dict
      {"name": str, "version": str, "fake": bool, "provider": str, "models": [exact model ids], "settings": {...},
       "agents": [{"id": str, "role": str}], "priority_entry": "where your system normally receives the user's priority",
       "supports": {"direct": bool, "restored": bool}}
  run(request) -> result                         REQUIRED. Runs the WHOLE workflow once, in a fresh context.
  decide_direct(request) -> result               OPTIONAL. Only the final decision step, given the priority, no upstream.
  decide_restored(request, decision_input) -> result
                                                 OPTIONAL. The final decision step again on the SAME upstream input it
                                                 received in a workflow run (decision_input), plus the priority stated
                                                 at that step.
  request = {"run_id", "execution_id", "repetition", "order", "condition", "direction" (A|B|None), "task",
             "option_a", "option_b", "priority" (str or None), "config": {...}}
  result  = {"final_text": "FIRST CHOICE: A|B|UNCLEAR ...",      # convert your system's decision into this first line
             "decision_input": <what the decider received from upstream; needed for restored>,
             "trace": {"format": "apa-trace/1", "agents": [{"id", "role", "model", "provider", "settings",
                        "request_messages": [{"role", "content"}] or None, "request_complete": bool,
                        "state_visible": {...} or None, "state_complete": bool, "output", "usage", "error"}]},
             "models_served": [exact model ids that actually answered], "errors": [...]}

CONDITIONS
  workflow              the whole workflow, the priority given where your system normally receives it (direction A, B)
  workflow_no_priority  the whole workflow without the priority (one execution per run and order, scored against both
                        directions: MATCHED only means the choice coincides with that direction's priority)
  direct                only if describe()["supports"]["direct"]: the decision step alone, with the priority
  restored              only if describe()["supports"]["restored"]: the decision step on the same upstream input as the
                        workflow run, plus the priority stated at that step
A condition the adapter does not support is recorded as NOT SUPPORTED and never run. The kit cannot inject a reminder
into your decision step unless the adapter exposes that step.

CHECKS
  - Every request gets a new execution_id; the adapter must build a fresh workflow context for it (no memory carryover).
  - Literal exposure checks on recorded requests and visible state: the priority text inside a no-priority execution, or
    the OPPOSITE priority inside a priority execution, is reported (state carryover or leakage). Presence of the text
    shows exposure; absence does not show that the information was absent (it may be paraphrased, or not captured).
  - Real (non-fake) adapters need --i-accept-costs and --max-executions equal to the planned count; the run stops
    (exit 4) if a model outside describe()["models"] served a request.

Exit codes: 0 finished; 2 refused; 4 stopped early.
"""
from __future__ import annotations

import datetime as _dt
import importlib
import json
import pathlib
import re
import secrets
from typing import Dict, List, Optional

from .chain import (DIRECTIONS, ORDERS, OUTCOMES, StopRun, canonical_json, file_sha256, load_scenario, scenario_sha256,
                    sha256_bytes, task_text, validate_scenario)
from .core import RecordWriter, parse_strict, prepare_out_dir

SUMMARY_FORMAT = "priority_check.workflow.summary/1"
TRACE_FORMAT = "apa-trace/1"
CONDITIONS = ("workflow", "workflow_no_priority", "direct", "restored")
OPTIONAL = ("direct", "restored")
CONDITION_LABELS = {"workflow": "Whole workflow, priority given at its normal entry",
                    "workflow_no_priority": "Whole workflow, no priority (control)",
                    "direct": "Decision step alone, given the priority",
                    "restored": "Decision step on the same upstream input, plus the priority"}
FAKE_NOTE = ("FAKE MODEL OUTPUT IS NOT EVIDENCE: the adapter reports fake (offline) models; the numbers say nothing about any "
             "real model.")


class AdapterError(ValueError):
    pass


def load_adapter(spec: str):
    mod, _, name = spec.partition(":")
    if not name:
        raise AdapterError("--adapter must be module:name")
    obj = getattr(importlib.import_module(mod), name)
    return obj() if isinstance(obj, type) else obj


def check_description(d) -> dict:
    """Validates describe(); returns it as plain JSON data."""
    if not isinstance(d, dict):
        raise AdapterError("describe() must return a dict")
    for k in ("name", "version", "fake", "provider", "models", "settings", "agents", "supports", "priority_entry"):
        if k not in d:
            raise AdapterError("describe() lacks %r" % k)
    if not isinstance(d["fake"], bool) or not isinstance(d["models"], list) or not all(isinstance(m, str) and m for m in d["models"]):
        raise AdapterError("describe(): fake must be true/false and models a list of exact model ids")
    if any(re.search(r"(^|[-:@/])latest($|[-:@/])", m) for m in d["models"]):
        raise AdapterError("describe(): models must be exact pinned ids, not 'latest' aliases")
    sup = d["supports"]
    if not isinstance(sup, dict) or set(sup) - set(OPTIONAL) or not all(isinstance(v, bool) for v in sup.values()):
        raise AdapterError("describe(): supports must be {'direct': bool, 'restored': bool}")
    if d["fake"] and any(re.match(r"(claude|gpt|gemini|o[0-9]|llama|mistral|qwen|deepseek|command|grok)[-_.0-9]", m, re.I) for m in d["models"]):
        raise AdapterError("describe(): fake is true but the model ids look like real models (%s); a real model needs fake: false, "
                           "which puts the run behind --i-accept-costs" % ", ".join(d["models"]))
    return json.loads(json.dumps(d))


def check_methods(adapter, desc: dict) -> None:
    for c, m in (("direct", "decide_direct"), ("restored", "decide_restored")):
        if desc["supports"].get(c) and not callable(getattr(adapter, m, None)):
            raise AdapterError("describe() says it supports %s, but the adapter has no %s() method" % (c, m))


def workflow_fingerprint(desc: dict) -> str:
    return sha256_bytes(canonical_json(desc))


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").strip().lower())


def _unesc(t: str) -> str:
    """Rule 5: undo JSON-style escapes before matching (\\uXXXX, \\", \\n), so JSON-embedded text still matches."""
    t = t or ""
    t = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), t)
    return t.replace('\\"', '"').replace("\\n", " ").replace("\\t", " ")


def _n(t: str, rule: int) -> str:
    return _norm(_unesc(t)) if rule >= 5 else _norm(t)


def _state_strings(st) -> List[str]:
    """Every string value (and key) in the visible state, unescaped (rule 4: a quote in a value no longer hides a match)."""
    out = []
    if isinstance(st, str):
        out.append(st)
    elif isinstance(st, dict):
        for k, v in st.items():
            out.append(str(k)); out += _state_strings(v)
    elif isinstance(st, (list, tuple)):
        for v in st:
            out += _state_strings(v)
    return out


def _texts(agent: dict, rule: int = 1) -> (List[str], List[str]):
    req = [m.get("content") for m in (agent.get("request_messages") or []) if isinstance(m, dict) and isinstance(m.get("content"), str)]
    st = agent.get("state_visible")
    if st is None:
        return req, []
    return req, (_state_strings(st) if rule >= 4 else [json.dumps(st, ensure_ascii=False)])


def literal_exposure(trace: dict, text: str, rule: int = 1, outputs: bool = False) -> List[dict]:
    """Where the exact text (case and whitespace normalised) appears in recorded requests or visible state; with
    outputs=True (rule 5, for texts that must not appear at all) also in an agent's output that its input lacks."""
    out, n = [], _norm(text)
    if not n:
        return out
    for a in (trace or {}).get("agents") or []:
        if not isinstance(a, dict):
            continue
        req, st = _texts(a, rule)
        if any(n in _n(t, rule) for t in req):
            out.append({"agent": a.get("id"), "where": "model request"})
        elif any(n in _n(t, rule) for t in st):
            out.append({"agent": a.get("id"), "where": "visible state only"})
        elif outputs and n in _n(a.get("output"), rule):
            out.append({"agent": a.get("id"), "where": "output, not in its recorded input"})
    return out


EXPOSURE_RULE = 5


def _has_cycle(n, edges):
    """True if the directed graph on n nodes with these (from, to) edges has a cycle."""
    succ, state = {k: [b for a, b in edges if a == k] for k in range(n)}, [0] * n

    def visit(k):
        state[k] = 1
        for m in succ[k]:
            if state[m] == 1 or (state[m] == 0 and visit(m)):
                return True
        state[k] = 2
        return False
    return any(state[k] == 0 and visit(k) for k in range(n))      # new records carry "exposure_rule": 5; rules 1 (no field) to 4 are kept so older records still verify
_SENT = re.compile(r"(?<=[.!?])\s+|\n+")


def _fragments(text: str) -> List[str]:
    """Normalised sentence-like fragments of 40+ characters; an output with none counts as one fragment if 40+ chars."""
    n = _norm(text)
    fr = [f.strip() for f in _SENT.split((text or "").strip().lower()) if f and len(f.strip()) >= 40]
    fr = [re.sub(r"\s+", " ", f) for f in fr]
    return fr or ([n] if len(n) >= 40 else [])


def _strip(text: str, parts) -> str:
    out = text
    for p in sorted((x for x in parts if x), key=len, reverse=True):
        out = out.replace(p, "\x00")
    return out


class ExposureTracker:
    """Literal exposure checks, in execution order (also used to recompute them from records when a run is opened).
    Presence of the text shows exposure; absence shows nothing.

    Carryover (rule 2, 2026-11-23). Evidence that an execution saw an EARLIER execution's output is a NOVEL fragment of
    that earlier output (a sentence of 40+ characters that no agent input had contained before it was produced, i.e. not
    template or scenario text: not in any earlier execution's inputs nor in the producing agent's own request) found
    in this execution's agent inputs, outside the parts this execution itself accounts
    for (its own agents' outputs, and in restored the reused workflow outputs, and the scenario's own texts). Identical or
    overlapping text that deterministic, cached or temperature-0 agents legitimately regenerate is therefore not
    carryover; a stale earlier output with content of its own still is. Rule 1 (records without "exposure_rule") is kept
    so earlier runs still verify against the rule they were written with."""

    def __init__(self, sc: dict):
        self.pri = {"A": sc["priority_A"], "B": sc["priority_B"]}
        self.scen = [_norm(sc.get(k)) for k in ("question", "context", "option_a", "option_b", "priority_A", "priority_B") if sc.get(k)]
        self.earlier = set()       # rule 1: normalised agent outputs (40+ chars) of earlier executions
        self.wf_outputs = {}       # (run, order, direction) -> outputs of that workflow execution (reused by restored)
        self.novel = set()         # rule 2: novel fragments of earlier executions' outputs
        self.inputs_seen = []      # rule 2: normalised agent inputs seen so far (all executions, in order)
        self.novel_by = {}         # rule 4: novel fragment -> ids of the agents that produced it
        self.out_by = {}           # rule 4: agent id -> its earlier outputs (normalised)
        self._carried = {}         # rule 5: agent id -> fragments it was flagged for carrying (never credited as its own)

    def check(self, rec: dict) -> None:
        tr, cond, d = rec.get("trace"), rec.get("condition"), rec.get("direction")
        rule = rec.get("exposure_rule", 1)
        o5 = rule >= 5      # rule 5: a priority that must not be there is also searched for in outputs
        if cond == "workflow_no_priority":
            e = {"priority_text_in_no_priority_execution": literal_exposure(tr, self.pri["A"], rule, o5) + literal_exposure(tr, self.pri["B"], rule, o5)}
        else:
            e = {"given_priority_found": literal_exposure(tr, self.pri[d], rule),
                 "opposite_priority_found": literal_exposure(tr, self.pri["B" if d == "A" else "A"], rule, o5)}
        agents = [ag for ag in (tr or {}).get("agents") or [] if isinstance(ag, dict)] if isinstance(tr, dict) else []
        own = {_norm(ag.get("output")) for ag in agents}
        key = (rec.get("run"), rec.get("order"), d)
        if cond == "workflow":
            self.wf_outputs[key] = set(own)
        reusable = own | (self.wf_outputs.get(key, set()) if cond == "restored" else set())
        seen = []
        if rule == 1:
            # carryover in any wording: an EARLIER execution's whole output present here (exact own regenerations exempt)
            cand = self.earlier - reusable
            for ag in agents:
                req, st = _texts(ag)
                if any(t in _norm(x) for t in cand for x in req):
                    seen.append({"agent": ag.get("id"), "where": "model request"})
                elif any(t in _norm(x) for t in cand for x in st):
                    seen.append({"agent": ag.get("id"), "where": "visible state only"})
        elif rule == 2:
            explained = list(reusable) + self.scen
            cand = [f for f in self.novel if not any(f in o for o in reusable)]
            for ag in agents:
                req, st = _texts(ag)
                if any(f in _strip(_norm(x), explained) for f in cand for x in req):
                    seen.append({"agent": ag.get("id"), "where": "model request"})
                elif any(f in _strip(_norm(x), explained) for f in cand for x in st):
                    seen.append({"agent": ag.get("id"), "where": "visible state only"})
        elif rule == 3:
            # rule 3 (order-aware): an agent's input is explained only by outputs of agents that ran BEFORE it in this
            # execution (plus, in restored, the reused workflow outputs) and by the scenario's texts, so carried-over text
            # that a later agent then repeats is still caught (agent usability test, skeptic, 2026-11-23)
            prior = set(self.wf_outputs.get(key, set())) if cond == "restored" else set()
            for ag in agents:
                req, st = _texts(ag)
                explained = list(prior) + self.scen
                cand = [f for f in self.novel if not any(f in o for o in prior)]
                if any(f in _strip(_norm(x), explained) for f in cand for x in req):
                    seen.append({"agent": ag.get("id"), "where": "model request"})
                elif any(f in _strip(_norm(x), explained) for f in cand for x in st):
                    seen.append({"agent": ag.get("id"), "where": "visible state only"})
                prior.add(_norm(ag.get("output")))
        elif rule == 4:
            # rule 4 = rule 3 on inputs (state matched on its string values), plus OUTPUTS (final skeptic test,
            # 2026-11-24): an agent whose output contains a novel sentence that a DIFFERENT agent produced in an earlier
            # execution, and that its own recorded input does not contain, got it from somewhere unrecorded (a memory or
            # cache step, hidden session state). An agent re-producing its own earlier sentence (determinism) is exempt.
            prior = set(self.wf_outputs.get(key, set())) if cond == "restored" else set()
            for ag in agents:
                req, st = _texts(ag, rule)
                explained = list(prior) + self.scen
                cand = [f for f in self.novel if not any(f in o for o in prior)]
                ins = [_strip(_norm(x), explained) for x in req], [_strip(_norm(x), explained) for x in st]
                if any(f in x for f in cand for x in ins[0]):
                    seen.append({"agent": ag.get("id"), "where": "model request"})
                elif any(f in x for f in cand for x in ins[1]):
                    seen.append({"agent": ag.get("id"), "where": "visible state only"})
                else:
                    raw_in = [_norm(x) for x in req + st]
                    on, mine = _norm(ag.get("output")), self.out_by.get(ag.get("id"), [])
                    outf = [f for f in self.novel if f in on and ag.get("id") not in self.novel_by.get(f, set())
                            and len(_strip(f, self.scen).replace("\x00", "").strip()) >= 40      # distinctive beyond scenario text
                            and not any(f in x for x in raw_in) and not any(f in o for o in prior)
                            and not any(f in o for o in mine)]                                     # not this agent's own earlier text
                    if outf:
                        seen.append({"agent": ag.get("id"), "where": "output, not in its recorded input"})
                prior.add(_norm(ag.get("output")))
        else:
            # rule 5 (fresh skeptic, 2026-11-23): inputs as in rule 3 with escapes undone; if the trace is visibly out of
            # execution order (an agent's request contains an agent's output listed after it), order is not relied on.
            # The output check of rule 4 becomes ADVISORY ("possible unrecorded source"): it cannot tell a memory leak
            # from legitimately shared text, so it no longer invalidates a run; a flagged agent is not credited as producer.
            outs = [_n(a.get("output"), rule) for a in agents]
            # an edge j -> i: agent i's request holds agent j's whole output (40+ chars, not already an earlier output).
            # A backward edge means the listed order is wrong ONLY if some order satisfies every edge (no cycle). A cycle
            # (e.g. the first agent's request holds the decider's text, and the decider depends on it) is not a listing
            # error: the text came from outside this execution, so the order is kept and the carryover is checked.
            edges = {(j, i) for i, a in enumerate(agents) for j in range(len(agents)) if j != i and len(outs[j]) >= 40
                     and not any(outs[j] in outs[k] for k in range(len(agents)) if k != j and k < min(i, j))
                     and any(outs[j] in _n(x, rule) for x in _texts(a, rule)[0])}
            misordered = any(j > i for j, i in edges) and not _has_cycle(len(agents), edges)
            base = set(self.wf_outputs.get(key, set())) if cond == "restored" else set()
            prior, unrec = (base | set(outs)) if misordered else set(base), []
            for i, ag in enumerate(agents):
                req, st = _texts(ag, rule)
                explained = list(prior) + self.scen
                cand = [f for f in self.novel if not any(f in o for o in prior)]
                ins = [_strip(_n(x, rule), explained) for x in req], [_strip(_n(x, rule), explained) for x in st]
                if any(f in x for f in cand for x in ins[0]):
                    seen.append({"agent": ag.get("id"), "where": "model request"})
                elif any(f in x for f in cand for x in ins[1]):
                    seen.append({"agent": ag.get("id"), "where": "visible state only"})
                raw_in = [_n(x, rule) for x in req + st]
                outf = [f for f in self.novel if f in outs[i] and ag.get("id") not in self.novel_by.get(f, set())
                        and len(_strip(f, self.scen).replace("\x00", "").strip()) >= 40
                        and not any(f in x for x in raw_in) and not any(f in o for o in prior)
                        and not any(f in o for o in self.out_by.get(ag.get("id"), []))]
                if outf:
                    unrec.append({"agent": ag.get("id"), "where": "output, not in its recorded input"})
                    self._carried.setdefault(ag.get("id"), set()).update(outf)
                if not misordered:
                    prior.add(outs[i])
            e["unrecorded_source_suspected"] = unrec
            if misordered:
                e["trace_order_not_relied_on"] = True
        e["earlier_execution_output_found"] = seen
        self.earlier |= {o for o in own if len(o) >= 40}
        u = (lambda t: _unesc(t)) if rule >= 5 else (lambda t: t)
        for ag in agents:      # novel = not template/scenario text: absent from earlier executions' inputs and from the
            mine = [_norm(u(x)) for x in _texts(ag)[0]]       # producing agent's own request (an echo of its prompt)
            for f in _fragments(u(ag.get("output"))):
                if not any(f in x for x in self.inputs_seen + mine) and not any(f in sc for sc in self.scen):
                    self.novel.add(f)
                if f in self.novel and not (rule >= 5 and f in self._carried.get(ag.get("id"), set())):
                    self.novel_by.setdefault(f, set()).add(ag.get("id"))
        for ag in agents:
            self.inputs_seen += [_norm(u(x)) for x in _texts(ag)[0]]
        for ag in agents:
            if not (rule >= 5 and self._carried.get(ag.get("id"))):
                self.out_by.setdefault(ag.get("id"), []).append(_norm(u(ag.get("output"))))
        rec["exposure"], rec["exposure_checked"] = e, True
        if rule != 1:
            rec["exposure_rule"] = rule


def recheck_exposure(recs: List[dict], sc: dict) -> List[str]:
    """Recomputes every execution's exposure from its trace; returns problems if any recorded exposure differs."""
    t, out = ExposureTracker(sc), []
    for r in recs:
        if r.get("kind") != "execution":
            continue
        if not r.get("exposure_checked"):
            if r.get("exposure"):
                out.append("an execution carries exposure results although none were computed for it")
            continue
        recorded = r.get("exposure")
        copy = dict(r)
        t.check(copy)
        if canonical_json(copy["exposure"]) != canonical_json(recorded):
            out.append("a recorded exposure check does not match its own trace (execution %s)" % r.get("execution_id"))
            break
    return out


def check_trace(trace) -> List[str]:
    """Problems with the trace shape (an empty or partial trace is allowed and reported as incomplete instrumentation)."""
    if trace is None:
        return []
    if not isinstance(trace, dict) or trace.get("format") != TRACE_FORMAT or not isinstance(trace.get("agents"), list):
        return ["trace must be {'format': '%s', 'agents': [...]}" % TRACE_FORMAT]
    probs = []
    for a in trace["agents"]:
        if not isinstance(a, dict) or not isinstance(a.get("id"), str):
            probs.append("every traced agent needs an 'id'"); break
        rm = a.get("request_messages")
        if rm is not None and (not isinstance(rm, list) or not all(isinstance(m, dict) for m in rm)):
            probs.append("agent %s: request_messages must be a list of {role, content}" % a.get("id"))
    return probs


def plan(desc: dict, runs: int, orders) -> List[dict]:
    """Every adapter invocation, in order. Per run and order: workflow A, workflow B, workflow without priority, then the
    supported probes (direct A, B; restored A, B, each restored after its own workflow execution)."""
    sup = desc["supports"]
    steps = []
    for r in range(runs):
        for order in orders:
            for d in DIRECTIONS:
                steps.append({"run": r, "order": order, "condition": "workflow", "direction": d})
            steps.append({"run": r, "order": order, "condition": "workflow_no_priority", "direction": None})
            if sup.get("direct"):
                for d in DIRECTIONS:
                    steps.append({"run": r, "order": order, "condition": "direct", "direction": d})
            if sup.get("restored"):
                for d in DIRECTIONS:
                    steps.append({"run": r, "order": order, "condition": "restored", "direction": d})
    return steps


def planned_records(desc: dict, runs: int, orders) -> int:
    """Execution records + decision records (the no-priority execution is scored against both directions)."""
    n = 0
    for s in plan(desc, runs, orders):
        n += 1 + (2 if s["condition"] == "workflow_no_priority" else 1)
    return n


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def run_workflow(sc: dict, adapter, runs: int = 1, orders=ORDERS, sink=None, run_id: Optional[str] = None, config=None) -> List[dict]:
    sc = validate_scenario(sc)
    desc = check_description(adapter.describe())
    check_methods(adapter, desc)
    run_id = run_id or "%s-%s" % (_dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"), secrets.token_hex(3))
    task = task_text(sc)
    pri = {"A": sc["priority_A"], "B": sc["priority_B"]}
    target = {"A": sc["option_a"], "B": sc["option_b"]}
    allowed = set(desc["models"])
    provider_label, model_label = "workflow:%s" % desc["name"], ",".join(sorted(desc["models"]))
    recs: List[dict] = []
    inputs = {}   # (run, order, direction) -> decision_input of that workflow execution, for restored
    tracker = ExposureTracker(sc)

    def emit(rec):
        recs.append(rec)
        if sink is not None:
            sink(rec)

    for st in plan(desc, runs, orders):
        r, order, cond, d = st["run"], st["order"], st["condition"], st["direction"]
        a, b = (sc["option_a"], sc["option_b"]) if order == "as_given" else (sc["option_b"], sc["option_a"])
        ex_id = "%s-r%d-%s-%s-%s-%s" % (run_id, r, order, cond, d or "none", secrets.token_hex(4))
        request = {"run_id": run_id, "execution_id": ex_id, "repetition": r, "order": order, "condition": cond, "direction": d,
                   "task": task, "option_a": a, "option_b": b, "priority": pri[d] if d and cond != "workflow_no_priority" else None,
                   "config": dict(config or {})}
        rec = {"kind": "execution", "fake": bool(desc["fake"]), "run_id": run_id, "run": r, "order": order, "condition": cond, "direction": d,
               "execution_id": ex_id, "scenario_id": sc["scenario_id"], "provider": provider_label, "model_requested": model_label,
               "model_served": None, "request": request, "final_text": None, "trace": None, "trace_problems": [],
               "errors": [], "error": None, "exposure": {}, "t_start": _now(), "t_end": None}
        stop, result = None, None
        try:
            if cond == "restored":
                if (r, order, d) not in inputs:
                    raise RuntimeError("not run: the workflow execution it depends on failed or gave no decision_input")
                result = adapter.decide_restored(request, inputs[(r, order, d)])
            elif cond == "direct":
                result = adapter.decide_direct(request)
            else:
                result = adapter.run(request)
            if not isinstance(result, dict):
                raise RuntimeError("the adapter returned %s, not a result dict" % type(result).__name__)
        except StopRun as e:
            rec["error"], stop = "stopped: %s" % e, e
        except Exception as e:   # recorded, never hidden
            rec["error"] = "%s: %s" % (type(e).__name__, e)
        rec["t_end"] = _now()
        if result is not None and rec["error"] is None:
            rec["final_text"] = result.get("final_text")
            rec["trace"] = result.get("trace")
            rec["trace_problems"] = check_trace(rec["trace"])
            rec["errors"] = [str(x) for x in result.get("errors") or []]
            tr_models = {str(ag.get("model")) for ag in ((rec["trace"] or {}).get("agents") or []) if isinstance(ag, dict) and ag.get("model")} if isinstance(rec["trace"], dict) else set()
            served = sorted({str(m) for m in result.get("models_served") or []} | tr_models)
            rec["model_served"] = ",".join(served) or None
            if served and not set(served) <= allowed:
                rec["error"] = "stopped: model(s) %s served (reported or in the trace), not in the adapter's declared %s" % (served, sorted(allowed))
                stop = StopRun(rec["error"])
            elif not served and not desc["fake"]:
                rec["error"] = "stopped: the adapter reported no served model id for a real-model execution (models_served is required)"
                stop = StopRun(rec["error"])
            if cond == "workflow" and "decision_input" in result:
                inputs[(r, order, d)] = result["decision_input"]
            rec["exposure_rule"] = EXPOSURE_RULE
            tracker.check(rec)
        emit(rec)
        ok = rec["error"] is None and isinstance(rec["final_text"], str)
        letter = parse_strict(rec["final_text"]) if ok else None
        shown = {"A": a, "B": b}
        for dd in (DIRECTIONS if cond == "workflow_no_priority" else (d,)):
            emit({"kind": "decision", "run_id": run_id, "run": r, "order": order, "condition": cond, "direction": dd,
                  "execution_id": ex_id, "shared_execution": cond == "workflow_no_priority", "scenario_id": sc["scenario_id"],
                  "provider": provider_label, "model_requested": model_label, "model_served": rec["model_served"],
                  "option_a_shown": a, "option_b_shown": b, "target_option_text": target[dd], "response_text": rec["final_text"],
                  "error": None if ok else (rec["error"] or "no final_text from the adapter"), "parsed": letter,
                  "chosen_option_text": shown.get(letter), "t_start": rec["t_start"], "t_end": rec["t_end"],
                  "outcome": ("MISSING" if not ok else "INVALID" if letter == "INVALID" else "UNCLEAR" if letter == "UNCLEAR"
                              else "MATCHED" if shown.get(letter) == target[dd] else "OPPOSITE")})
        if stop is not None:
            raise stop
    return recs


def summarise_workflow(recs: List[dict], conditions) -> dict:
    dec = [x for x in recs if x["kind"] == "decision"]
    counts = {c: {d: {o: 0 for o in OUTCOMES} for d in DIRECTIONS} for c in conditions}
    for x in dec:
        counts[x["condition"]][x["direction"]][x["outcome"]] += 1
    paired = {}
    for c in conditions:
        idx = {(x["run_id"], x["run"], x["order"], x["direction"]): x for x in dec if x["condition"] == c}
        cases = sorted({k[:3] for k in idx})
        both = [(idx.get(k + ("A",)), idx.get(k + ("B",))) for k in cases]
        both = [(p, q) for p, q in both if p and q]
        ok = ("MATCHED", "OPPOSITE", "UNCLEAR")
        readable = [(p, q) for p, q in both if p["outcome"] in ok and q["outcome"] in ok]
        paired[c] = {"cases": len(both), "readable_cases": len(readable),
                     "both_priorities_got_their_own_option": sum(1 for p, q in readable if p["outcome"] == q["outcome"] == "MATCHED")}
    ex = [x for x in recs if x["kind"] == "execution"]
    served = sorted({x["model_served"] for x in recs if x.get("model_served")})
    return {"calls_recorded": len(recs), "executions": len(ex), "decision_records": len(dec),
            "executions_failed": sum(1 for x in ex if x["error"]),
            "providers": sorted({x["provider"] for x in recs}), "models_requested": sorted({str(x["model_requested"]) for x in recs}),
            "models_served": served, "runs": len({x["run"] for x in recs}), "orders": sorted({x["order"] for x in recs}),
            "counts": counts, "paired": paired}


def exposure_summary(recs: List[dict]) -> dict:
    ex = [x for x in recs if x["kind"] == "execution" and x.get("exposure")]
    traced = [x for x in recs if x["kind"] == "execution" and isinstance(x.get("trace"), dict)]
    by_agent = {}
    for x in ex:
        if x["condition"] == "workflow":
            for f in x["exposure"].get("given_priority_found") or []:
                k = by_agent.setdefault(f["agent"], {"model request": 0, "visible state only": 0})
                k[f["where"]] += 1
    allex = [x for x in recs if x["kind"] == "execution"]
    return {"no_priority_executions_with_priority_text": sum(1 for x in ex if x["exposure"].get("priority_text_in_no_priority_execution")),
            "executions_without_served_model": sum(1 for x in allex if not x.get("model_served") and not x.get("error")),
            "executions_with_earlier_execution_output": sum(1 for x in ex if x["exposure"].get("earlier_execution_output_found")),
            "workflow_priority_found_by_agent": by_agent,
            "priority_executions_with_opposite_priority_text": sum(1 for x in ex if x["exposure"].get("opposite_priority_found")),
            "executions_with_trace": len(traced),
            "executions_without_trace": sum(1 for x in recs if x["kind"] == "execution") - len(traced),
            "agent_requests_not_fully_captured": sum(1 for x in traced for a in x["trace"].get("agents") or []
                                                     if isinstance(a, dict) and not a.get("request_complete")),
            **({"executions_with_unrecorded_source_suspected": sum(1 for x in ex if x["exposure"].get("unrecorded_source_suspected")),
                "executions_with_trace_out_of_order": sum(1 for x in ex if x["exposure"].get("trace_order_not_relied_on"))}
               if any((x.get("exposure_rule") or 1) >= 5 for x in ex) else {}),
            "note": "Literal checks: the text being present shows exposure; its absence does not show the information was absent "
                    "(it may be paraphrased, or the instrumentation may not capture it)."}


def code_fingerprint(adapter) -> dict:
    """sha256 of every .py file in the adapter's module directory (not recursive): a change to the adapter or to the
    workflow code beside it changes this even if describe() does not. Code elsewhere is not covered; say so."""
    import inspect
    try:
        f = pathlib.Path(inspect.getsourcefile(type(adapter))).resolve()
    except (TypeError, OSError):
        return {"sha256": None, "files": [], "note": "adapter source not found"}
    files = sorted(p for p in f.parent.glob("*.py"))
    h = sha256_bytes(b"".join(p.name.encode() + b"\0" + p.read_bytes() + b"\0" for p in files))
    return {"sha256": h, "files": [p.name for p in files],
            "note": "covers the .py files in the adapter's folder only; code imported from elsewhere is not covered"}


def execute(sc: dict, adapter, out_dir, runs: int, orders, config=None, adapter_spec=None):
    sc = validate_scenario(sc)
    desc = check_description(adapter.describe())
    conditions = [c for c in CONDITIONS if c not in OPTIONAL or desc["supports"].get(c)]
    out = prepare_out_dir(out_dir)
    w = RecordWriter(out)
    code, stop_msg = 0, None
    try:
        run_workflow(sc, adapter, runs=runs, orders=orders, sink=w.write, config=config)
    except StopRun as e:
        code, stop_msg = 4, str(e)
    finally:
        w.close()
    with open(w.path, encoding="utf-8") as f:
        recs = [json.loads(line) for line in f]
    from . import __version__
    s = {"summary_format": SUMMARY_FORMAT, "kit_version": __version__, "fake_run": bool(desc["fake"]),
         "run_id": recs[0]["run_id"] if recs else None, "scenario_id": sc["scenario_id"], "scenario": sc,
         "scenario_sha256": scenario_sha256(sc), "prompt_templates_sha256": None,
         "workflow": desc, "workflow_fingerprint": workflow_fingerprint(desc),
         "provider": "workflow:%s" % desc["name"], "model_requested": ",".join(sorted(desc["models"])),
         "openrouter_provider_slug": None, "served_providers": [], "settings": desc["settings"], "request_parameters_sent": [],
         "conditions": conditions, "not_supported": [c for c in OPTIONAL if c not in conditions],
         "directions": list(DIRECTIONS), "orders_requested": list(orders), "runs_requested": runs,
         "planned_executions": len(plan(desc, runs, orders)), "planned_calls": planned_records(desc, runs, orders),
         "records_file": "records.jsonl", "records_sha256": file_sha256(w.path), "config": dict(config or {}),
         "code": code_fingerprint(adapter), "adapter_spec": adapter_spec,
         "reproduce": "python -m priority_check workflow --scenario <scenario.json, sha256 %s> --adapter %s --runs %d --orders %s%s --out <new folder>" % (
             scenario_sha256(sc)[:16], adapter_spec or "<module:name>", runs, "both" if len(orders) == 2 else "as_given",
             (" --config '%s'" % json.dumps(config)) if config else "")}
    if desc["fake"]:
        s["fake_note"] = FAKE_NOTE
    s.update(summarise_workflow(recs, conditions))
    s["exposure_checks"] = exposure_summary(recs)
    if code == 4:
        s["incomplete"] = "run stopped after %d records: %s" % (len(recs), stop_msg)
    with open(out / "summary.json", "x", encoding="utf-8") as f:
        f.write(json.dumps(s, indent=1) + "\n")
    with open(out / "report.md", "x", encoding="utf-8", errors="backslashreplace") as f:
        f.write(render_md(s))
    return code, {"records": str(w.path), "summary": str(out / "summary.json"), "report": str(out / "report.md")}, s


def _md(t) -> str:
    """Adapter-supplied text in report.md: no raw HTML."""
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_md(s: dict) -> str:
    L = ["# Whole-workflow priority check", ""]
    if s["fake_run"]:
        L += ["> **" + FAKE_NOTE + "**", ""]
    if s.get("incomplete"):
        L += ["**INCOMPLETE RUN:** %s" % s["incomplete"], ""]
    wf = s["workflow"]
    L += ["Workflow: %s %s (fingerprint %s). Agents: %s." % (_md(wf["name"]), _md(wf["version"]), s["workflow_fingerprint"][:16],
                                                            ", ".join("%s (%s)" % (_md(a.get("id")), _md(a.get("role"))) for a in wf["agents"])),
          "Models: %s. Priority enters: %s." % (_md(", ".join(wf["models"])), _md(wf["priority_entry"])),
          "Scenario: %s (sha256 %s). Runs per case: %d. Orders: %s. Executions: %d of %d planned." % (
              s["scenario_id"], s["scenario_sha256"][:16], s["runs_requested"], ", ".join(s["orders_requested"]),
              s["executions"], s["planned_executions"]), ""]
    if s["not_supported"]:
        L += ["**NOT SUPPORTED by this adapter, so not tested:** %s." % ", ".join(s["not_supported"]), ""]
    L += ["| condition | priority favours | " + " | ".join(OUTCOMES) + " |", "|---|---|" + "---|" * len(OUTCOMES)]
    for c in s["conditions"]:
        for d in DIRECTIONS:
            k = s["counts"][c][d]
            L.append("| %s | %s | %s |" % (CONDITION_LABELS[c], d, " | ".join(str(k[o]) for o in OUTCOMES)))
    e = s["exposure_checks"]
    L += ["", "## Exposure checks (literal)", "",
          "- No-priority executions whose recorded requests or state contain a priority's text: %d" % e["no_priority_executions_with_priority_text"],
          "- Priority executions containing the OPPOSITE priority's text (carryover between executions?): %d" % e["priority_executions_with_opposite_priority_text"],
          "- Executions containing a novel part of an EARLIER execution's agent output (carryover between executions; repeated template or task text is not counted): %d" % e["executions_with_earlier_execution_output"],
          "- Executions without a trace: %d; agent requests not fully captured: %d; executions with no served model reported: %d" % (
              e["executions_without_trace"], e["agent_requests_not_fully_captured"], e["executions_without_served_model"]),
          "- Where the given priority's text was found, per agent (whole-workflow executions): %s" % (
              "; ".join("%s: in its model request %d, only in state it could read %d" % (_md(k), v["model request"], v["visible state only"])
                        for k, v in sorted(e["workflow_priority_found_by_agent"].items())) or "nowhere"),
          "- " + e["note"], "",
          "## How to read this", "",
          "- This tested the workflow the adapter ran, as the adapter describes it. Descriptive counts for one scenario; no "
          "statistical test. %s" % ("With one run per case, differences mix in run-to-run variation." if s["runs_requested"] == 1 else
                                   "%d runs per case are repeated samples of this one scenario, not more scenarios." % s["runs_requested"]),
          "- The no-priority control is one execution per run and order, scored against both directions: MATCHED there only "
          "means the choice coincides with that priority.", "",
          "## Reproduce", "", "    " + s["reproduce"], "",
          "Code fingerprint: %s (%s)." % ((s["code"]["sha256"] or "none")[:16], s["code"]["note"]), ""]
    return "\n".join(L)


def export_trace(execution: dict, scenario: dict) -> dict:
    """One execution's trace as an apa-trace/1 file for the Workflow Map's declared-versus-observed view."""
    req = execution.get("request") or {}
    tr = execution.get("trace") or {}
    return {"format": TRACE_FORMAT, "priority": req.get("priority") or "", "task": req.get("task"), "option_a": req.get("option_a"),
            "option_b": req.get("option_b"), "fake": execution.get("fake"),
            "control_priorities": [scenario["priority_A"], scenario["priority_B"]] if not req.get("priority") else [],
            "opposite_priority": (scenario["priority_B"] if execution.get("direction") == "A" else scenario["priority_A"]) if req.get("priority") else "",
            "source": {k: execution.get(k) for k in ("run_id", "execution_id", "condition", "direction", "order", "run")},
            "agents": tr.get("agents") or []}


def add_workflow_parser(sub):
    import argparse
    c = sub.add_parser("workflow", help="test your own whole multi-agent workflow through an adapter", description=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    c.add_argument("--scenario", required=True)
    c.add_argument("--adapter", required=True, help="module:name of your workflow adapter (see the contract above)")
    c.add_argument("--out", required=True, help="a new or empty directory")
    c.add_argument("--runs", type=int, default=1, help="independent repetitions, each in a fresh context (default 1)")
    c.add_argument("--orders", choices=("both", "as_given"), default="both")
    c.add_argument("--config", help="JSON object passed to the adapter in every request (e.g. a configuration you change between runs)")
    c.add_argument("--i-accept-costs", action="store_true", help="required when the adapter reports real (non-fake) models")
    c.add_argument("--max-executions", type=int, help="required for real adapters: must equal the planned number of executions")
    return c


def main_workflow(a) -> int:
    import sys

    def refuse(m):
        print("refused: %s" % m, file=sys.stderr)
        return 2
    if a.runs < 1:
        return refuse("--runs must be at least 1")
    out = pathlib.Path(a.out)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        return refuse("--out %s exists and is not empty; results are never overwritten" % a.out)
    try:
        sc = load_scenario(a.scenario)
        cfg = json.loads(a.config) if a.config else {}
        if not isinstance(cfg, dict):
            raise AdapterError("--config must be a JSON object")
        adapter = load_adapter(a.adapter)
        desc = check_description(adapter.describe())
        check_methods(adapter, desc)
    except (ValueError, OSError, ImportError, AttributeError) as e:
        return refuse(str(e))
    orders = ORDERS if a.orders == "both" else ("as_given",)
    n = len(plan(desc, a.runs, orders))
    unsupported = [c for c in OPTIONAL if not desc["supports"].get(c)]
    print("adapter %s %s: %s; models %s" % (desc["name"], desc["version"], "FAKE (offline)" if desc["fake"] else "REAL models",
                                            ", ".join(desc["models"])))
    print("planned workflow executions and probes: %d (%d run(s) x %d order(s): workflow A, B, no priority%s)%s" % (
        n, a.runs, len(orders), "".join(", %s A, B" % c for c in OPTIONAL if desc["supports"].get(c)),
        ("; NOT SUPPORTED: " + ", ".join(unsupported)) if unsupported else ""))
    if not desc["fake"]:
        if not a.i_accept_costs:
            return refuse("the adapter reports real models: --i-accept-costs is required (every execution is billed to you)")
        if a.max_executions != n:
            return refuse("--max-executions must equal the planned %d" % n)
    code, paths, s = execute(sc, adapter, a.out, a.runs, orders, config=cfg, adapter_spec=a.adapter)
    if desc["fake"]:
        print("FAKE MODEL OUTPUT IS NOT EVIDENCE about any model.")
    for c in s["conditions"]:
        k = s["counts"][c]
        print("%-21s A: %s  B: %s" % (c, " ".join("%s=%d" % (o[:3], v) for o, v in k["A"].items() if v) or "-",
                                       " ".join("%s=%d" % (o[:3], v) for o, v in k["B"].items() if v) or "-"))
    pp = s.get("paired") or {}
    heads = ["%s %d of %d" % (c, pp[c]["both_priorities_got_their_own_option"], pp[c]["readable_cases"]) for c in ("workflow", "direct", "restored") if c in pp]
    if heads:
        print("PAIRS (both opposite priorities got their own option): " + "; ".join(heads))
    e = s["exposure_checks"]
    if e["executions_with_trace"] == 0:
        print("WARNING: the adapter returned no trace for any execution, so no exposure was checked (the zeros mean nothing)")
    elif e["executions_without_trace"]:
        print("note: %d execution(s) without a trace; their exposure is unknown" % e["executions_without_trace"])
    if e["executions_without_served_model"]:
        print("WARNING: %d execution(s) reported no served model id" % e["executions_without_served_model"])
    if e["no_priority_executions_with_priority_text"]:
        print("WARNING: priority text found in %d no-priority execution(s): the no-priority control saw a priority (see report.md, exposure checks)" % e["no_priority_executions_with_priority_text"])
    if e["priority_executions_with_opposite_priority_text"]:
        print("WARNING: the opposite priority's text found in %d priority execution(s) (see report.md, exposure checks)" % e["priority_executions_with_opposite_priority_text"])
    if e.get("executions_with_unrecorded_source_suspected"):
        print("NOTE (advisory, does not invalidate): in %d execution(s) an agent's output contained another agent's sentence from an earlier "
              "execution that its recorded input lacks: a possible unrecorded source (memory, cache, hidden history) or legitimately "
              "shared text. Check those agents' traces (see report.md)." % e["executions_with_unrecorded_source_suspected"])
    if e.get("executions_with_trace_out_of_order"):
        print("NOTE: in %d execution(s) the trace does not list agents in execution order; the carryover check did not rely on order there."
              % e["executions_with_trace_out_of_order"])
    if e["executions_with_earlier_execution_output"]:
        print("WARNING: %d execution(s) contained a novel part of an EARLIER execution's output (carryover between executions; "
              "repeated template or task text is not counted). Executions were not independent (see report.md, exposure checks)" % e["executions_with_earlier_execution_output"])
    print(json.dumps(paths, indent=1))
    if code == 4:
        print("stopped early: %s" % s["incomplete"], file=sys.stderr)
    return code
