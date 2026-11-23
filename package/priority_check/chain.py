"""priority_check.chain: test a FIXED six-handoff workflow (advisor -> critic -> summarizer, twice) on your own
two-option scenario.

For each priority direction (priority_A favours option A, priority_B favours option B) and each option order, it runs
  - one six-handoff chain whose first handoff receives the priority (only handoff 1 sees it), and
  - one six-handoff chain started WITHOUT the priority (no-priority control),
then five separate final-decision calls:
  direct              decision prompt with the priority line, no handoff
  delegated           decision prompt with the last handoff (t6) of the priority chain, no priority line
  restored            the same t6 handoff plus the priority line repeated
  direct_no_priority  decision prompt with neither priority nor handoff
  chain_no_priority   decision prompt with the t6 handoff of the no-priority chain, no priority line

Every decision is scored by the kit's strict parser (first line 'FIRST CHOICE: A|B|UNCLEAR') against the option the
direction's priority favours, by option TEXT (so swapped orders are scored correctly):
  MATCHED / OPPOSITE / UNCLEAR (incl. an explicit 'FIRST CHOICE: UNCLEAR' decline) / INVALID (no strict first line,
  e.g. a free-text refusal) / MISSING (the call failed, or could not be made because an earlier handoff failed).

The fixed six-handoff chain is the ONLY workflow supported. A general user-defined workflow adapter is not built.
The prompt templates below are generic (a {priority} slot, no questionnaire wording). Standard library only.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import pathlib
import secrets
from typing import Callable, Dict, List, Optional

from .core import HANDOFF_CLOSE, HANDOFF_OPEN, INSTRUCTION, INTRO, RecordWriter, build_prompt, parse_strict, prepare_out_dir

SCENARIO_KEYS_REQUIRED = ("scenario_id", "question", "option_a", "option_b", "priority_A", "priority_B")
SCENARIO_KEYS_OPTIONAL = ("context",)
MAX_FIELD_CHARS = 4000

# ---- generic handoff templates (fixed design: only handoff 1 can see the priority, the task and the options)
ADVISOR_WITH_PRIORITY = ("Someone has asked you for help with a decision.\n\n"
                         "What they have told you matters to them:\n{priority}\n\n"
                         "Their situation:\n{task}\n\n"
                         "Give them your advice.")
ADVISOR_NO_PRIORITY = ("Someone has asked you for help with a decision.\n\n"
                       "Their situation:\n{task}\n\n"
                       "Give them your advice.")
CRITIC = "You are reviewing the following advice.\n\n{prev}\n\nGive your critique of it."
SUMMARIZER = "The following is a discussion of someone's decision.\n\n{prev}\n\nWrite the guidance for them."
ADVISOR_CONTINUE = "The following is a discussion of someone's decision.\n\n{prev}\n\nAdvise them on what to do."
HANDOFF_TEMPLATES = (None, CRITIC, SUMMARIZER, ADVISOR_CONTINUE, CRITIC, SUMMARIZER)   # index 0 = handoff 1
HANDOFF_ROLES = ("advisor", "critic", "summarizer", "advisor_continue", "critic", "summarizer")
N_HANDOFFS = 6

DIRECTIONS = ("A", "B")
ORDERS = ("as_given", "swapped")
CONDITIONS = ("direct", "delegated", "restored", "direct_no_priority", "chain_no_priority")
OUTCOMES = ("MATCHED", "OPPOSITE", "UNCLEAR", "INVALID", "MISSING")
CALLS_PER_CASE = 2 * N_HANDOFFS + len(CONDITIONS)   # 17


class ScenarioError(ValueError):
    pass


class StopRun(Exception):
    """Raised by a provider to stop the whole run (e.g. the served model differs from the requested one)."""


def validate_scenario(obj) -> dict:
    """Strict: a JSON object with exactly the required keys (plus optional 'context'), each a non-empty string of at
    most MAX_FIELD_CHARS characters; the two options differ; the two priorities differ."""
    if not isinstance(obj, dict):
        raise ScenarioError("scenario must be a JSON object")
    unknown = sorted(set(obj) - set(SCENARIO_KEYS_REQUIRED) - set(SCENARIO_KEYS_OPTIONAL))
    if unknown:
        raise ScenarioError("unknown field(s): %s (allowed: %s)" % (", ".join(unknown), ", ".join(SCENARIO_KEYS_REQUIRED + SCENARIO_KEYS_OPTIONAL)))
    missing = [k for k in SCENARIO_KEYS_REQUIRED if k not in obj]
    if missing:
        raise ScenarioError("missing field(s): %s" % ", ".join(missing))
    for k, v in obj.items():
        if not isinstance(v, str) or not v.strip():
            raise ScenarioError("field %r must be a non-empty string" % k)
        if len(v) > MAX_FIELD_CHARS:
            raise ScenarioError("field %r is longer than %d characters" % (k, MAX_FIELD_CHARS))
    if obj["option_a"].strip() == obj["option_b"].strip():
        raise ScenarioError("option_a and option_b must differ")
    if obj["priority_A"].strip() == obj["priority_B"].strip():
        raise ScenarioError("priority_A and priority_B must differ")
    return {k: obj[k].strip() for k in obj}


def load_scenario(path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            obj = json.load(f)
    except json.JSONDecodeError as e:
        raise ScenarioError("scenario is not valid JSON: %s" % e)
    return validate_scenario(obj)


def task_text(sc: dict) -> str:
    return sc["question"] + ("\n" + sc["context"] if sc.get("context") else "")


def task_block(task: str, a: str, b: str) -> str:
    return "TASK: %s\nOPTION A: %s\nOPTION B: %s" % (task, a, b)


def handoff_prompt(n: int, prev: Optional[str], task: str, a: str, b: str, priority: Optional[str]) -> str:
    """Prompt for handoff n (1..6). Handoff 1 sees the task, the options and (with-priority chain) the priority;
    handoffs 2..6 see only the previous handoff's text."""
    if n == 1:
        tb = task_block(task, a, b)
        return (ADVISOR_WITH_PRIORITY.replace("{task}", tb).replace("{priority}", priority) if priority is not None
                else ADVISOR_NO_PRIORITY.replace("{task}", tb))
    if prev is None:
        raise ValueError("handoff %d needs the previous handoff's text" % n)
    return HANDOFF_TEMPLATES[n - 1].replace("{prev}", prev)


def planned_calls(runs: int, orders: int) -> int:
    return runs * len(DIRECTIONS) * orders * CALLS_PER_CASE


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def run_chain(sc: dict, provider, runs: int = 1, orders=ORDERS, sink: Optional[Callable[[dict], None]] = None,
              run_id: Optional[str] = None) -> List[dict]:
    """Runs the whole design and returns one record per planned call (failed and not-made calls included).
    provider.complete(prompt) -> (text, served_model_id); provider.model_requested is recorded.
    Any other exception from a call makes that call MISSING; StopRun propagates after the record is written."""
    sc = validate_scenario(sc)
    run_id = run_id or "%s-%s" % (_dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"), secrets.token_hex(3))   # unique even within a second
    task = task_text(sc)
    recs: List[dict] = []

    def call(base: dict, prompt: Optional[str], upstream_failed: bool) -> dict:
        rec = dict(base, run_id=run_id, scenario_id=sc["scenario_id"], provider=getattr(provider, "name", "custom"),
                   model_requested=getattr(provider, "model_requested", None), model_served=None, prompt=prompt,
                   response_text=None, error=None, t_start=None, t_end=None)
        stop = None
        if upstream_failed:
            rec["error"] = "not called: an earlier handoff of this chain failed"
        else:
            rec["t_start"] = _now()
            try:
                text, served = provider.complete(prompt)
                rec["response_text"], rec["model_served"] = text, served
            except StopRun as e:
                rec["error"], stop = "stopped: %s" % e, e
            except Exception as e:   # recorded, never hidden
                rec["error"] = "%s: %s" % (type(e).__name__, e)
            rec["t_end"] = _now()
            ex = getattr(provider, "last_exchange", None)
            if ex is not None:                       # real providers: exact request parameters and full raw response
                rec["exchange"] = json.loads(json.dumps(ex))
                provider.last_exchange = None
        ok = rec["error"] is None and isinstance(rec["response_text"], str)
        if rec["kind"] == "decision":
            letter = parse_strict(rec["response_text"]) if ok else None
            shown = {"A": rec["option_a_shown"], "B": rec["option_b_shown"]}
            rec["parsed"] = letter
            rec["chosen_option_text"] = shown.get(letter)
            rec["outcome"] = ("MISSING" if not ok else "INVALID" if letter == "INVALID" else "UNCLEAR" if letter == "UNCLEAR"
                              else "MATCHED" if rec["chosen_option_text"] == rec["target_option_text"] else "OPPOSITE")
        else:
            rec["outcome"] = "OK" if ok else "MISSING"
        recs.append(rec)
        if sink is not None:
            sink(rec)
        if stop is not None:
            raise stop
        return rec

    for r in range(runs):
        for order in orders:
            a, b = (sc["option_a"], sc["option_b"]) if order == "as_given" else (sc["option_b"], sc["option_a"])
            for d in DIRECTIONS:
                pri = sc["priority_A"] if d == "A" else sc["priority_B"]
                target = sc["option_a"] if d == "A" else sc["option_b"]
                case = {"run": r, "order": order, "direction": d, "option_a_shown": a, "option_b_shown": b,
                        "target_option_text": target}
                t6 = {}
                for arm, p in (("with_priority", pri), ("no_priority", None)):
                    chain_id = "r%d-%s-%s-%s" % (r, order, d, arm)
                    prev, failed = None, False
                    for n in range(1, N_HANDOFFS + 1):
                        prompt = None if failed else handoff_prompt(n, prev, task, a, b, p)
                        rec = call(dict(case, kind="handoff", chain_id=chain_id, chain_arm=arm, handoff=n,
                                        role=HANDOFF_ROLES[n - 1], condition=None), prompt, failed)
                        failed = rec["outcome"] != "OK"
                        prev = rec["response_text"]
                    t6[arm] = None if failed else prev
                specs = (("direct", "", pri, None), ("delegated", t6["with_priority"], None, "with_priority"),
                         ("restored", t6["with_priority"], pri, "with_priority"), ("direct_no_priority", "", None, None),
                         ("chain_no_priority", t6["no_priority"], None, "no_priority"))
                for cond, handoff_text, line, arm in specs:
                    up = handoff_text is None
                    prompt = None if up else build_prompt(task, a, b, handoff_text, line)
                    call(dict(case, kind="decision", condition=cond, handoff=None, role="decision",
                              chain_id=("r%d-%s-%s-%s" % (r, order, d, arm)) if arm else None, chain_arm=arm),
                         prompt, up)
    return recs


def summarise_chain(recs: List[dict]) -> dict:
    dec = [x for x in recs if x["kind"] == "decision"]
    counts = {c: {d: {o: 0 for o in OUTCOMES} for d in DIRECTIONS} for c in CONDITIONS}
    for x in dec:
        counts[x["condition"]][x["direction"]][x["outcome"]] += 1
    paired = {}
    for c in CONDITIONS:
        idx = {(x["run_id"], x["run"], x["order"], x["direction"]): x for x in dec if x["condition"] == c}
        cases = sorted({k[:3] for k in idx})
        both = [(idx.get(k + ("A",)), idx.get(k + ("B",))) for k in cases]
        both = [(p, q) for p, q in both if p and q]
        readable = [(p, q) for p, q in both if p["outcome"] in ("MATCHED", "OPPOSITE", "UNCLEAR") and q["outcome"] in ("MATCHED", "OPPOSITE", "UNCLEAR")]
        paired[c] = {"cases": len(both), "readable_cases": len(readable),
                     "both_priorities_got_their_own_option": sum(1 for p, q in readable if p["outcome"] == q["outcome"] == "MATCHED")}
    hand = [x for x in recs if x["kind"] == "handoff"]
    served = sorted({x["model_served"] for x in recs if x["model_served"]})
    return {"calls_recorded": len(recs), "decision_calls": len(dec), "handoff_calls": len(hand),
            "handoff_calls_missing": sum(1 for x in hand if x["outcome"] == "MISSING"),
            "providers": sorted({x["provider"] for x in recs}),
            "models_requested": sorted({str(x["model_requested"]) for x in recs}), "models_served": served,
            "runs": len({x["run"] for x in recs}), "orders": sorted({x["order"] for x in recs}),
            "counts": counts, "paired": paired}


# ---- run identity: everything `compare` needs to judge whether two runs are comparable
SUMMARY_FORMAT = "priority_check.chain.summary/2"
FAKE_NOTE = ("FAKE MODEL OUTPUT IS NOT EVIDENCE: this run used the built-in deterministic fake provider; its numbers say "
             "nothing about any real model.")


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def scenario_sha256(sc: dict) -> str:
    """sha256 of the validated scenario (fields stripped as validate_scenario does) as canonical JSON: sorted keys,
    no spaces, UTF-8. Whitespace-only edits at the ends of a field do not change it; any other edit does."""
    return sha256_bytes(canonical_json(validate_scenario(sc)))


def prompt_templates_sha256() -> str:
    """sha256 of the kit's handoff templates and decision-prompt parts. A kit change to the prompts changes it."""
    return sha256_bytes(canonical_json([ADVISOR_WITH_PRIORITY, ADVISOR_NO_PRIORITY, CRITIC, SUMMARIZER, ADVISOR_CONTINUE,
                                        list(HANDOFF_ROLES), INTRO, HANDOFF_OPEN, HANDOFF_CLOSE, INSTRUCTION]))


def file_sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def run_identity(sc: dict, provider, runs: int, orders, fake: bool, recs: List[dict], records_path) -> dict:
    """The run-level fields a comparison needs. Settings come from provider.settings() (None if the provider has no such
    method); request_parameters_sent lists each distinct request body actually sent, without the prompt text (fake: [])."""
    from . import __version__
    settings = provider.settings() if callable(getattr(provider, "settings", None)) else None
    sent = {}
    for x in recs:
        body = (x.get("exchange") or {}).get("request_body")
        if isinstance(body, dict):
            params = {k: v for k, v in body.items() if k not in ("messages", "contents")}
            sent.setdefault(canonical_json(params), params)
    served_providers = sorted({str(x["exchange"]["served_provider"]) for x in recs
                               if isinstance(x.get("exchange"), dict) and x["exchange"].get("served_provider") is not None})
    meta = {"summary_format": SUMMARY_FORMAT, "kit_version": __version__, "fake_run": bool(fake),
            "run_id": recs[0]["run_id"] if recs else None,
            "scenario_id": sc["scenario_id"], "scenario_sha256": scenario_sha256(sc),
            "prompt_templates_sha256": prompt_templates_sha256(),
            "provider": getattr(provider, "name", "custom"), "model_requested": getattr(provider, "model_requested", None),
            "openrouter_provider_slug": getattr(provider, "provider_slug", None) if getattr(provider, "name", None) == "openrouter" else None,
            "served_providers": served_providers,
            "settings": settings, "request_parameters_sent": [sent[k] for k in sorted(sent)],
            "conditions": list(CONDITIONS), "directions": list(DIRECTIONS), "orders_requested": list(orders),
            "runs_requested": runs, "planned_calls": planned_calls(runs, len(orders)),
            "records_file": "records.jsonl", "records_sha256": file_sha256(records_path)}
    if fake:
        meta["fake_note"] = FAKE_NOTE
    return meta


CONDITION_LABELS = {"direct": "Direct (priority, no chain)", "delegated": "Delegated (t6 only, no priority)",
                    "restored": "Restored (t6 + priority repeated)", "direct_no_priority": "Direct, no priority",
                    "chain_no_priority": "Chain without priority, then decision"}


def render_chain_md(s: dict, fake: bool) -> str:
    L = ["# Six-handoff workflow check", ""]
    if fake:
        L += ["> **FAKE MODEL OUTPUT IS NOT EVIDENCE.** This run used the built-in deterministic fake provider. It shows "
              "that the workflow runs and how the outputs look; its numbers say nothing about any real model.", ""]
    if s.get("incomplete"):
        L += ["**INCOMPLETE RUN:** %s" % s["incomplete"], ""]
    if s.get("scenario_sha256"):
        L += ["Scenario: %s (sha256 %s). Records sha256: %s. Kit %s." % (s["scenario_id"], s["scenario_sha256"][:16],
                                                                       s["records_sha256"][:16], s["kit_version"]),
              "Settings: %s." % json.dumps(s["settings"], sort_keys=True), ""]
    L += ["Provider(s): %s. Model requested: %s. Model served: %s." % (", ".join(s["providers"]), ", ".join(s["models_requested"]),
                                                                        ", ".join(s["models_served"]) or "none"),
          "Calls recorded: %d (%d handoffs, %d of them missing; %d decisions). Runs per case: %d. Orders: %s." % (
              s["calls_recorded"], s["handoff_calls"], s["handoff_calls_missing"], s["decision_calls"], s["runs"], ", ".join(s["orders"])), "",
          "Workflow (fixed): advisor -> critic -> summarizer -> advisor -> critic -> summarizer. Only handoff 1 receives the "
          "priority. Each priority direction and option order has its own chains.", "",
          "Outcomes: MATCHED (chose the option the direction's priority favours), OPPOSITE, UNCLEAR (incl. explicit decline "
          "via 'FIRST CHOICE: UNCLEAR'), INVALID (no strict first line), MISSING (call failed or not made). For the "
          "no-priority conditions, MATCHED means the choice happens to coincide with that direction's priority.", "",
          "## Counts per condition and priority direction", "",
          "| condition | priority favours | MATCHED | OPPOSITE | UNCLEAR | INVALID | MISSING |", "|---|---|---|---|---|---|---|"]
    for c in CONDITIONS:
        for d in DIRECTIONS:
            k = s["counts"][c][d]
            L.append("| %s | %s | %s |" % (CONDITION_LABELS[c], d, " | ".join(str(k[o]) for o in OUTCOMES)))
    L += ["", "## Paired measure: did both opposing priorities get their own option?", "",
          "A case is one run and one option order; it pairs the priority_A and priority_B decisions of the same condition.", "",
          "| condition | cases | readable cases | both got their own option |", "|---|---|---|---|"]
    for c in CONDITIONS:
        p = s["paired"][c]
        L.append("| %s | %d | %d | %d |" % (CONDITION_LABELS[c], p["cases"], p["readable_cases"], p["both_priorities_got_their_own_option"]))
    L += ["", "## How to read this", "",
          ("- With one run per case, every difference between conditions mixes in ordinary run-to-run variation: the same "
           "prompt can give a different answer when called again. Use --runs 2 or more to see that variation." if s["runs"] <= 1 else
           "- %d runs per case: each cell counts repeated answers (run-to-run variation), all from this one "
           "scenario (the same prompts, repeated, in each option order); they are not separate scenarios. No statistical test is run." % s["runs"]),
          "- These are descriptive counts for one scenario and one model configuration. They support no causal claim about "
          "why a condition differs, and no claim about other scenarios, models or workflows.",
          "- The no-priority controls are run separately for each direction, so they are independent repeats of the same "
          "prompts: disagreement between their two directions shows run-to-run variation.", ""]
    return "\n".join(L)


def write_chain_outputs(summary: dict, out_dir, fake: bool) -> Dict[str, str]:
    out = pathlib.Path(out_dir)
    p1, p2 = out / "summary.json", out / "report.md"
    with open(p1, "x", encoding="utf-8") as f:
        f.write(json.dumps(summary, indent=1) + "\n")
    with open(p2, "x", encoding="utf-8", errors="backslashreplace") as f:
        f.write(render_chain_md(summary, fake))
    return {"summary": str(p1), "report": str(p2)}


def execute(sc: dict, provider, out_dir, runs: int, orders, fake: bool) -> (int, Dict[str, str], dict):
    """Writes records.jsonl call by call, then summary.json and report.md. Returns (exit_code, paths, summary).
    Exit code 4 when a provider stopped the run (e.g. served-model mismatch); the summary is then marked incomplete."""
    out = prepare_out_dir(out_dir)
    w = RecordWriter(out)
    code, recs = 0, []
    try:
        recs = run_chain(sc, provider, runs=runs, orders=orders, sink=w.write)
    except StopRun as e:
        code = 4
        stop_msg = str(e)
    finally:
        w.close()
    with open(w.path, encoding="utf-8") as f:
        recs = [json.loads(line) for line in f]
    s = run_identity(sc, provider, runs, orders, fake, recs, w.path)
    s.update(summarise_chain(recs))   # the existing summary fields, unchanged, follow the run identity
    if code == 4:
        s["incomplete"] = "run stopped after %d calls: %s" % (len(recs), stop_msg)
    paths = {"records": str(w.path)}
    paths.update(write_chain_outputs(s, out, fake))
    return code, paths, s
