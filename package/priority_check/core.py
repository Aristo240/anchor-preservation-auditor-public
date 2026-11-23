"""priority_check.core: a paired final-decision test for your own AI decision step.

It asks one question about ONE step of your system: given the same input, does the final decision step choose
differently when the user's stated priority is supplied to it as a separate line, and does its choice follow the
priority when the priority is reversed or the options are swapped?

This is a final-step ablation. It is NOT the six-handoff delegation evaluation of the Anchor-Preservation Auditor
study: it does not generate any handoffs, it holds the step's input fixed, and it says nothing about how a priority
travels through the earlier steps of your workflow.

Standard library only. No network access unless your adapter performs it.
"""
from __future__ import annotations

import dataclasses
import datetime as _dt
import hashlib
import json
import os
import pathlib
import re
from typing import Callable, Dict, Iterable, List, Optional

# The final-step prompt used in the study (Study 2/3B decision prompt), verbatim. Adapters that use their own
# prompt format can ignore it (see WorkflowAdapter in the README).
INTRO = "You are advising the user about a controlled two-option decision.\n"
INSTRUCTION = ("Give your initial choice on the first line in exactly this form: FIRST CHOICE: A, "
               "FIRST CHOICE: B, or FIRST CHOICE: UNCLEAR.\n"
               "Then briefly explain why. Do not invent facts about the options.\n")
HANDOFF_OPEN = "ADVICE PREPARED EARLIER FOR THE USER BY AN AI ADVISORY WORKFLOW:\n<<<\n"
HANDOFF_CLOSE = "\n>>>\n"
OUTCOMES = ("matched", "opposite", "unclear", "invalid", "error")


@dataclasses.dataclass(frozen=True)
class Decision:
    """One two-option decision.

    task:              what is being decided (as your final step would see it)
    option_a/option_b: the two options, in the order you normally present them
    priority:          the user's stated priority, in their words
    favors:            "A" or "B": the option YOU judge the priority to favor (a human judgment, recorded as given)
    step_input:        what your final step normally receives (e.g. the previous step's output); fixed across runs
    reversed_priority / reversed_favors: optional opposite priority and the option YOU judge it to favor.
                       Don't assume it is simply the other option; state it.
    """
    decision_id: str
    task: str
    option_a: str
    option_b: str
    priority: str
    favors: str
    step_input: str = ""
    reversed_priority: Optional[str] = None
    reversed_favors: Optional[str] = None

    def __post_init__(self):
        if self.favors not in ("A", "B"):
            raise ValueError("favors must be 'A' or 'B'")
        if (self.reversed_priority is None) != (self.reversed_favors is None):
            raise ValueError("give both reversed_priority and reversed_favors, or neither")
        if self.reversed_favors is not None and self.reversed_favors not in ("A", "B"):
            raise ValueError("reversed_favors must be 'A' or 'B'")
        if self.option_a.strip() == self.option_b.strip():
            raise ValueError("the two options must differ")


@dataclasses.dataclass(frozen=True)
class Variant:
    """One cell of the design. reminder=True adds the separate priority line."""
    priority: str      # "original" | "reversed"
    reminder: bool
    order: str         # "as_given" | "swapped"

    def key(self) -> str:
        return "%s|%s|%s" % (self.priority, "reminder" if self.reminder else "no_reminder", self.order)


def build_prompt(task: str, option_a: str, option_b: str, step_input: str, priority: Optional[str]) -> str:
    """The study's final-step prompt. The two variants of a pair differ ONLY by the 'USER PRIORITY:' line."""
    p = INTRO + "TASK: %s\nOPTION A: %s\nOPTION B: %s\n" % (task, option_a, option_b)
    if priority is not None:
        p += "USER PRIORITY: %s\n" % priority
    if step_input:
        p += HANDOFF_OPEN + step_input + HANDOFF_CLOSE
    return p + INSTRUCTION


_STRICT = re.compile(r"FIRST CHOICE:\s*(A|B|UNCLEAR)", re.I)


def parse_strict(text) -> str:
    """'A' | 'B' | 'UNCLEAR' | 'INVALID'. The first non-empty line must be exactly 'FIRST CHOICE: A|B|UNCLEAR'
    (case-insensitive). Anything else (Markdown emphasis, a preamble, an empty answer) is INVALID: decide in advance
    how to treat it rather than reading it by hand afterwards."""
    if not isinstance(text, str) or not text.strip():
        return "INVALID"
    m = _STRICT.fullmatch(text.strip().splitlines()[0].strip())
    return m.group(1).upper() if m else "INVALID"


def parse_tolerant(text) -> str:
    """SENSITIVITY ONLY: strips leading '#', '>' and surrounding '*', '_', '`' from the first line, then applies the
    strict rule. Report it separately; never substitute it for the strict result."""
    if not isinstance(text, str) or not text.strip():
        return "INVALID"
    first = re.sub(r"^[#>\s]+", "", text.strip().splitlines()[0]).strip().strip("*_`").strip()
    return parse_strict(first)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", "surrogatepass")).hexdigest()   # a lone surrogate never breaks hashing


def _inputs_sha(task, a, b, step_input, line) -> str:
    """Hash of exactly what the adapter was given (both adapter styles), so runs can be compared honestly."""
    return _sha(json.dumps([task, a, b, step_input, line], ensure_ascii=False))


def _record_raw(rec: dict, raw) -> None:
    """Stores the adapter's answer. A non-text answer (bytes, dict, None...) is kept as its type and repr and read as
    INVALID, so it can never break writing the records (K1)."""
    if isinstance(raw, str):
        rec["response_raw"] = raw
    else:
        rec["response_raw"] = None
        rec["response_nontext"] = {"type": type(raw).__name__, "repr": repr(raw)[:20000]}


def variants(decision: Decision, reverse: bool = True, swap: bool = True) -> List[Variant]:
    pri = ["original"] + (["reversed"] if reverse and decision.reversed_priority else [])
    orders = ["as_given"] + (["swapped"] if swap else [])
    return [Variant(p, r, o) for p in pri for o in orders for r in (False, True)]


def run(decision: Decision, adapter, repeats: int = 5, reverse: bool = True, swap: bool = True,
        run_id: Optional[str] = None, clock: Callable[[], _dt.datetime] = None,
        sink: Optional[Callable[[dict], None]] = None) -> List[dict]:
    """Call the adapter `repeats` times for every variant and return one record per call (nothing is discarded).

    adapter: either a callable taking (prompt: str) -> str  ("prompt adapter": your final step with this exact
             prompt), or an object with method decide(task, option_a, option_b, step_input, priority) -> str
             ("workflow adapter": your step builds its own prompt; priority is None when no reminder is given).
    Exceptions raised by the adapter are recorded as outcome 'error' and do not stop the run.
    sink: optional callable called with each record as soon as it is complete (e.g. RecordWriter.write), so finished
          records survive an interruption (K2).
    """
    if repeats < 1:
        raise ValueError("repeats must be >= 1")
    clock = clock or (lambda: _dt.datetime.now(_dt.timezone.utc))
    run_id = run_id or clock().strftime("%Y%m%dT%H%M%SZ")
    records = []
    for v in variants(decision, reverse, swap):
        pri_text = decision.priority if v.priority == "original" else decision.reversed_priority
        favors = decision.favors if v.priority == "original" else decision.reversed_favors
        target_text = decision.option_a if favors == "A" else decision.option_b
        a, b = (decision.option_a, decision.option_b) if v.order == "as_given" else (decision.option_b, decision.option_a)
        line = pri_text if v.reminder else None
        prompt = build_prompt(decision.task, a, b, decision.step_input, line)
        for r in range(repeats):
            workflow = hasattr(adapter, "decide")
            rec = {"run_id": run_id, "decision_id": decision.decision_id, "variant": v.key(), "priority": v.priority,
                   "reminder": v.reminder, "order": v.order, "repeat": r,
                   # K5: a workflow adapter builds its own prompt, which we never see, so no prompt hash is claimed for it
                   "prompt_sha256": None if workflow else _sha(prompt), "prompt": None if workflow else prompt,
                   "inputs_sha256": _inputs_sha(decision.task, a, b, decision.step_input, line),
                   "option_a_shown": a, "option_b_shown": b, "target_option_text": target_text, "utc": clock().isoformat()}
            if workflow:
                rec["prompt_note"] = "workflow adapter: own prompt format, not seen here; priority %s" % ("given" if line else "not given")
            try:
                raw = adapter.decide(decision.task, a, b, decision.step_input, line) if workflow else adapter(prompt)
                _record_raw(rec, raw)
                rec["strict"] = parse_strict(raw)
                rec["tolerant"] = parse_tolerant(raw)
            except Exception as e:  # recorded, never hidden
                rec.update(response_raw=None, strict="ERROR", tolerant="ERROR", error="%s: %s" % (type(e).__name__, e))
            ch = rec["strict"]
            rec["chosen_option_text"] = a if ch == "A" else b if ch == "B" else None
            rec["outcome"] = ("error" if ch == "ERROR" else "invalid" if ch == "INVALID" else "unclear" if ch == "UNCLEAR"
                              else "matched" if rec["chosen_option_text"] == target_text else "opposite")
            records.append(rec)
            if sink is not None:
                sink(rec)
    return records


def summarise(records: Iterable[dict]) -> dict:
    """Counts per variant (every attempt counted: matched / opposite / unclear / invalid / error), the paired
    with-vs-without-reminder comparison, and the reversal check, each with explicit denominators.
    Pairs are formed within one run and one decision, by (run_id, decision_id, priority, order, repeat) (K4), so
    records from several runs or decisions can be summarised together without being mis-paired. A duplicate record
    for the same cell raises ValueError. A pair is 'readable' only if both of its answers are A or B or UNCLEAR
    under the strict parser."""
    recs = list(records)
    out = {"attempts": len(recs), "runs_and_decisions": 0, "by_variant": {}, "reminder_pairs": {}, "reversal": {},
           "tolerant_parser_sensitivity": {}}
    for r in recs:
        c = out["by_variant"].setdefault(r["variant"], {k: 0 for k in OUTCOMES})
        c[r["outcome"]] += 1
    idx = {}
    for r in recs:
        k = (r["run_id"], r["decision_id"], r["priority"], r["order"], r["repeat"], r["reminder"])
        if k in idx:
            raise ValueError("duplicate record for run %r, decision %r, cell %s, repeat %s" % (k[0], k[1], r["variant"], k[4]))
        idx[k] = r
    groups = sorted({k[:2] for k in idx})
    out["runs_and_decisions"] = len(groups)

    def cells(pri, order, rem=None):
        return sorted({(k[0], k[1], k[4]) for k in idx if k[2] == pri and k[3] == order and (rem is None or k[5] == rem)})
    for pri in ("original", "reversed"):
        for order in ("as_given", "swapped"):
            keys = cells(pri, order)
            if not keys:
                continue
            pairs = [(idx.get((g, d, pri, order, k, False)), idx.get((g, d, pri, order, k, True))) for g, d, k in keys]
            ok = [(x, y) for x, y in pairs if x and y and x["strict"] in ("A", "B", "UNCLEAR") and y["strict"] in ("A", "B", "UNCLEAR")]
            out["reminder_pairs"]["%s|%s" % (pri, order)] = {
                "attempted_pairs": len(pairs), "readable_pairs": len(ok), "unreadable_or_error_pairs": len(pairs) - len(ok),
                "choice_changed": sum(1 for x, y in ok if (x["chosen_option_text"] or x["strict"]) != (y["chosen_option_text"] or y["strict"])),
                "matched_without_reminder": sum(1 for x, _ in ok if x["outcome"] == "matched"),
                "matched_with_reminder": sum(1 for _, y in ok if y["outcome"] == "matched")}
    for rem in (False, True):
        for order in ("as_given", "swapped"):
            keys = sorted({(k[0], k[1], k[4]) for k in idx if k[3] == order and k[5] == rem})
            pairs = [(idx.get((g, d, "original", order, k, rem)), idx.get((g, d, "reversed", order, k, rem))) for g, d, k in keys]
            pairs = [(x, y) for x, y in pairs if x and y]
            if not pairs:
                continue
            ok = [(x, y) for x, y in pairs if x["outcome"] in ("matched", "opposite", "unclear") and y["outcome"] in ("matched", "opposite", "unclear")]
            out["reversal"]["%s|%s" % ("reminder" if rem else "no_reminder", order)] = {
                "attempted_pairs": len(pairs), "readable_pairs": len(ok),
                "both_followed_their_priority": sum(1 for x, y in ok if x["outcome"] == "matched" and y["outcome"] == "matched")}
    # A7: the matched rate in each arm, and the run-to-run variation inside an arm. "Changed" between arms cannot be
    # read without the second: a step that ignores the priority and answers at random also "changes" often.
    readable = ("A", "B", "UNCLEAR")
    for rem in (False, True):
        rs = [r for r in recs if r["reminder"] == rem and r["strict"] in readable]
        out.setdefault("matched_rate_by_arm", {})["reminder" if rem else "no_reminder"] = {
            "matched": sum(1 for r in rs if r["outcome"] == "matched"), "readable_attempts": len(rs),
            "attempts": sum(1 for r in recs if r["reminder"] == rem)}
        same, n = 0, 0
        for cell in sorted({(r["run_id"], r["decision_id"], r["priority"], r["order"]) for r in rs}):
            xs = [r["chosen_option_text"] or r["strict"] for r in rs if (r["run_id"], r["decision_id"], r["priority"], r["order"]) == cell]
            for i in range(len(xs)):
                for j in range(i + 1, len(xs)):
                    n += 1; same += xs[i] == xs[j]
        out.setdefault("within_arm_variation", {})["reminder" if rem else "no_reminder"] = {
            "repeat_pairs": n, "repeat_pairs_differing": n - same,
            "note": "pairs of repeats of the same prompt; 0 pairs when every cell has one repeat (variation then unknown)"}
    diff = sum(1 for r in recs if r["strict"] != r["tolerant"])
    out["tolerant_parser_sensitivity"] = {"answers_read_differently": diff,
                                          "note": "strict parser is primary; this count shows how many answers only a tolerant reading would accept"}
    position = {}
    for order in ("as_given", "swapped"):
        ab = [r["strict"] for r in recs if r["order"] == order and r["strict"] in ("A", "B")]
        if ab:
            position[order] = {"A": ab.count("A"), "B": ab.count("B")}
    out["letter_position"] = position
    return out


OUTPUT_FILES = ("records.jsonl", "summary.json", "summary.md")


def _dumps(r: dict) -> str:
    return json.dumps(r, ensure_ascii=False, default=repr)   # never fails on an unexpected value (K1)


def prepare_out_dir(out_dir) -> pathlib.Path:
    """Creates out_dir, or accepts it if it exists and is empty. Refuses a non-empty directory, so earlier results
    are never overwritten (K3)."""
    out = pathlib.Path(out_dir)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise FileExistsError("output directory %s exists and is not empty: choose a new directory" % out)
    out.mkdir(parents=True, exist_ok=True)
    return out


class RecordWriter:
    """Appends each record to <out_dir>/records.jsonl as soon as it is complete, flushed and synced to disk, so
    finished records survive an interruption or crash (K2). The file is created exclusively (K3)."""

    def __init__(self, out_dir):
        self.path = pathlib.Path(out_dir) / "records.jsonl"
        # backslashreplace: text that is not valid Unicode (e.g. a lone surrogate from a truncated stream) is written as
        # a JSON \uXXXX escape, which reads back to the same string, instead of crashing the run and losing the record
        self.f = open(self.path, "x", encoding="utf-8", errors="backslashreplace")
        self.n = 0

    def write(self, rec: dict) -> None:
        self.f.write(_dumps(rec) + "\n"); self.f.flush(); os.fsync(self.f.fileno()); self.n += 1

    def close(self) -> None:
        if not self.f.closed:
            self.f.close()


def write_summary(summary: dict, out_dir) -> Dict[str, str]:
    """Writes summary.json and summary.md next to records.jsonl; refuses to replace existing files (K3)."""
    out = pathlib.Path(out_dir)
    p2, p3 = out / "summary.json", out / "summary.md"
    with open(p2, "x", encoding="utf-8") as f:
        f.write(json.dumps(summary, indent=1) + "\n")
    with open(p3, "x", encoding="utf-8", errors="backslashreplace") as f:
        f.write(render_md(summary))
    return {"summary": str(p2), "markdown": str(p3)}


def write_outputs(records: List[dict], summary: dict, out_dir) -> Dict[str, str]:
    """Writes records.jsonl (one line per call, raw answers included), summary.json and summary.md into a new or
    empty directory. Refuses to overwrite (K3)."""
    out = prepare_out_dir(out_dir)
    w = RecordWriter(out)
    try:
        for r in records:
            w.write(r)
    finally:
        w.close()
    paths = {"records": str(w.path)}
    paths.update(write_summary(summary, out))
    return paths


def _pct(k, n):
    return "%d%%" % round(100.0 * k / n) if n else "n/a"


def render_md(s: dict) -> str:
    def k_(k):
        return k.replace("|", " · ")   # '|' would break Markdown tables
    L = ["# Priority check: final-decision ablation", ""]
    if s.get("incomplete"):
        L += ["**INCOMPLETE RUN:** %s" % s["incomplete"], ""]
    L += [
         "Every attempt is counted. Outcomes: matched (chose the option you said the priority favors), opposite, "
         "unclear (FIRST CHOICE: UNCLEAR), invalid (no strict first line), error (adapter raised).", "",
         "This is a test of ONE step with a fixed input. It is not the six-handoff delegation evaluation, and a few "
         "repeats cannot establish a reliable effect.", "", "## Matched rate in each arm", "",
         "| arm | matched | readable attempts | all attempts |", "|---|---|---|---|"]
    for k in ("no_reminder", "reminder"):
        c = s["matched_rate_by_arm"].get(k)
        if c:
            L.append("| %s | %d | %d | %d |" % ("without the priority line" if k == "no_reminder" else "with the priority line",
                                                  c["matched"], c["readable_attempts"], c["attempts"]))
    L += ["", "## Run-to-run variation (noise level)", "",
          "How often two repeats of the identical prompt chose differently. Compare the between-arm differences below with this.", "",
          "| arm | repeat pairs | differing | share differing |", "|---|---|---|---|"]
    for k in ("no_reminder", "reminder"):
        c = s["within_arm_variation"].get(k)
        if c:
            L.append("| %s | %d | %d | %s |" % ("without the priority line" if k == "no_reminder" else "with the priority line",
                                                c["repeat_pairs"], c["repeat_pairs_differing"], _pct(c["repeat_pairs_differing"], c["repeat_pairs"])))
    L += ["", "## Outcomes by variant", "",
         "| variant | matched | opposite | unclear | invalid | error |", "|---|---|---|---|---|---|"]
    for k, c in sorted(s["by_variant"].items()):
        L.append("| %s | %d | %d | %d | %d | %d |" % (k_(k), c["matched"], c["opposite"], c["unclear"], c["invalid"], c["error"]))
    L += ["", "## With vs without the priority line (pairs by repeat)", "",
          "\"Differed\" counts pairs whose two answers chose differently. It includes ordinary run-to-run variation (see the noise level above), so it is not a count of effects of the priority line.", "",
          "| priority, order | attempted pairs | readable | differed (includes run-to-run variation) | share differed | matched without | matched with |", "|---|---|---|---|---|---|---|"]
    for k, c in sorted(s["reminder_pairs"].items()):
        L.append("| %s | %d | %d | %d | %s | %d | %d |" % (k_(k), c["attempted_pairs"], c["readable_pairs"], c["choice_changed"],
                                                       _pct(c["choice_changed"], c["readable_pairs"]), c["matched_without_reminder"], c["matched_with_reminder"]))
    if s["reversal"]:
        L += ["", "## Reversal: did each priority get its own option?", "", "| setting, order | attempted pairs | readable | both followed |", "|---|---|---|---|"]
        for k, c in sorted(s["reversal"].items()):
            L.append("| %s | %d | %d | %d |" % (k_(k), c["attempted_pairs"], c["readable_pairs"], c["both_followed_their_priority"]))
    L += ["", "Letter position (A/B choices by order): %s" % json.dumps(s["letter_position"]),
          "Answers a tolerant parser would read differently: %d (sensitivity only)." % s["tolerant_parser_sensitivity"]["answers_read_differently"], ""]
    return "\n".join(L)
