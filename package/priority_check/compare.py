"""priority_check.compare: compare a new `chain` run with an earlier one (a developer regression check).

    python -m priority_check compare --baseline OLD_DIR_OR_SUMMARY --candidate NEW_DIR_OR_SUMMARY [--json OUT.json]
                                     [--fail-on-drop CONDITION[:DIRECTION]:N ...]

It first classifies the pair (the browser page assets/runcompare.js applies the same rules; a test checks both agree):
  SAME CONFIGURATION       nothing recorded differs: for looking at repeatability and run-to-run variation;
  CONFIGURATION CHANGE     the same scenario, priority conditions, option orders and outcome definitions, both runs
                           complete and of the same kind (fake or real), but one or more configuration dimensions differ
                           (model, provider, settings, request parameters sent, reference-workflow prompts, kit version,
                           number of repetitions). EVERY detected difference is listed, not only the intended one. A
                           descriptive comparison, never an isolated causal effect when more than one thing changed;
  NOT A VALID CONTROLLED COMPARISON  a different scenario, priority conditions, option orders or summary/outcome format,
                           a fake run against a real one, an incomplete run, or settings not recorded. Every reason is
                           listed; the counts are still shown side by side, labelled descriptive only.

Then it prints, descriptively, per condition and priority direction, the MATCHED / OPPOSITE / UNCLEAR / INVALID /
MISSING counts of each run and their change (kept separate: nothing is folded into OPPOSITE), and the paired count
"both opposing priorities got their own option". It runs no statistical test and has no built-in pass/fail threshold.

It also states how many repetitions each side has: every decision comes from ONE scenario, so repeated runs and the two
option orders are repeated samples of that scenario, never additional independent scenarios.

--fail-on-drop is YOUR OWN pre-set rule, not a kit threshold: CONDITION:N fails (exit 1) when the MATCHED count of that
condition (both directions together; CONDITION:A:N or CONDITION:B:N for one direction) is lower in the candidate than
in the baseline by more than N. Rules are evaluated for SAME CONFIGURATION and CONFIGURATION CHANGE, never for an
invalid comparison.

Exit codes: 0 same configuration (no rule of yours tripped); 3 configuration change (no rule of yours tripped);
1 a rule of yours tripped; 2 refused (missing or unreadable input, records that do not match their summary, an invalid
rule, --json path exists); 5 not a valid controlled comparison."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from typing import List, Optional

from .chain import CONDITIONS, DIRECTIONS, OUTCOMES, ScenarioError, canonical_json, file_sha256, scenario_sha256, sha256_bytes, summarise_chain
from .core import parse_strict
from . import workflow as WF

COMPARE_FORMAT = "priority_check.chain.compare/2"
EXIT_OK, EXIT_RULE, EXIT_REFUSED, EXIT_CHANGED, EXIT_NOT_COMPARABLE = 0, 1, 2, 3, 5
SAME, CHANGED, INVALID = "same_configuration", "configuration_change", "not_valid"
VERDICT_LABELS = {SAME: "SAME CONFIGURATION", CHANGED: "CONFIGURATION CHANGE", INVALID: "NOT A VALID CONTROLLED COMPARISON"}
REPEAT_WARNING = "Differences may reflect run-to-run variation. Repeat each configuration to assess consistency."

REQUIRED_FIELDS = ("summary_format", "kit_version", "fake_run", "scenario_id", "scenario_sha256", "prompt_templates_sha256",
                   "provider", "model_requested", "models_served", "openrouter_provider_slug", "served_providers", "settings",
                   "request_parameters_sent", "conditions", "directions", "orders_requested", "runs_requested",
                   "planned_calls", "records_sha256", "calls_recorded", "counts", "paired")

# (summary field, label, class) checked for equality, in report order. INVALID: the pair is not a valid controlled
# comparison. CHANGED: a configuration dimension. Mirrored in the site's assets/runcompare.js (FIELDS); a test checks.
FIELDS = (("fake_run", "fake or real run", INVALID), ("summary_format", "summary and outcome format", INVALID),
          ("scenario_sha256", "scenario content (sha256)", INVALID), ("scenario_id", "scenario id", INVALID),
          ("conditions", "conditions", INVALID), ("directions", "priority directions", INVALID),
          ("orders_requested", "option orders", INVALID),
          ("provider", "provider", CHANGED), ("model_requested", "model requested", CHANGED),
          ("models_served", "model(s) served", CHANGED), ("openrouter_provider_slug", "OpenRouter provider slug", CHANGED),
          ("served_providers", "served provider(s)", CHANGED), ("settings", "settings", CHANGED),
          ("request_parameters_sent", "request parameters sent", CHANGED),
          ("prompt_templates_sha256", "reference-workflow prompt templates (sha256)", CHANGED),
          ("kit_version", "kit version", CHANGED), ("runs_requested", "repetitions (runs per case)", CHANGED),
          ("workflow_fingerprint", "workflow configuration (the adapter's description: agents, models, settings)", CHANGED),
          ("config", "configuration passed to the workflow (--config)", CHANGED),
          ("code", "workflow code (sha256 of the .py files in the adapter's folder)", CHANGED))
MODEL_FIELDS = ("provider", "model_requested", "models_served", "openrouter_provider_slug", "served_providers")
VALIDITY_FIELDS = tuple((f, l) for f, l, _ in FIELDS)   # kept for callers of the r1 API

IDENTITY_FIELDS = ("summary_format", "kit_version", "fake_run", "run_id", "scenario_id", "scenario_sha256",
                   "prompt_templates_sha256", "provider", "model_requested", "models_served", "openrouter_provider_slug",
                   "served_providers", "settings", "request_parameters_sent", "conditions", "directions",
                   "orders_requested", "runs_requested", "planned_calls", "calls_recorded", "records_sha256", "incomplete")


class Refused(Exception):
    pass


BUNDLE_FORMAT = "apa-result/1"


def load_run(path) -> dict:
    """A run directory (summary.json + records.jsonl: the records' sha256 and the counts are re-checked against the
    summary), a result saved from the browser page (format apa-result/1: the summary plus the records text, checked the
    same way), or a summary.json file alone (the records cannot be checked; this is reported)."""
    p = pathlib.Path(path)
    if p.is_dir():
        sp, rp = p / "summary.json", p / "records.jsonl"
        if not sp.is_file() or not rp.is_file():
            raise Refused("%s must contain summary.json and records.jsonl" % p)
    elif p.is_file():
        sp, rp = p, None
    else:
        raise Refused("%s does not exist" % p)
    try:
        with open(sp, encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Refused("%s is not a readable JSON summary: %s" % (sp, e))
    if not isinstance(s, dict):
        raise Refused("%s is not a JSON object" % sp)
    records_text = None
    if s.get("format") == BUNDLE_FORMAT:
        extra = sorted(set(s) - {"format", "saved_note", "summary", "records_jsonl"})
        if extra or not isinstance(s.get("summary"), dict) or not isinstance(s.get("records_jsonl"), (str, type(None))):
            raise Refused("%s is not a valid saved result (%s)" % (sp, ", ".join(extra) or "summary or records_jsonl malformed"))
        s, records_text = s["summary"], s["records_jsonl"]
    missing = [k for k in REQUIRED_FIELDS if k not in s]
    if missing:
        raise Refused("%s lacks %s: not a chain summary, or written by a kit version without run identity; re-run `chain`"
                      % (sp, ", ".join(missing)))
    for why in summary_problems(s):
        raise Refused("%s: %s" % (sp, why))
    verified = False
    if rp is not None or records_text is not None:
        if rp is not None:
            got = file_sha256(rp)
        else:
            rp = "%s (records_jsonl)" % sp
            got = hashlib.sha256(records_text.encode("utf-8")).hexdigest()
        if got != s["records_sha256"]:
            raise Refused("%s: sha256 %s does not match the summary's records_sha256 %s (the records were changed after "
                          "the run, or the summary belongs to another run)" % (rp, got, s["records_sha256"]))
        try:
            if records_text is None:
                with open(rp, encoding="utf-8") as f:
                    records_text = f.read()
            recs = [json.loads(line) for line in records_text.split("\n") if line.strip()]
            again = resummarise(recs, s)
        except KeyError as e:
            raise Refused("%s: a record has a condition, direction or outcome (%s) that the summary does not list" % (rp, e))
        except (ValueError, TypeError) as e:
            raise Refused("%s could not be re-summarised: %s" % (rp, e))
        for k in ("counts", "paired", "calls_recorded"):
            if canonical_json(again[k]) != canonical_json(s[k]):
                raise Refused("%s: the summary's %r does not match its own records.jsonl (the summary was edited)" % (sp, k))
        for why in identity_mismatches(s, again) + record_problems(recs, s):
            raise Refused("%s: %s" % (sp, why))
        verified = True
    return {"source": str(p), "summary_path": str(sp), "records_verified": verified, "summary": s,
            "records_times_sha256": _times_sha(recs) if verified else None}


def identity_mismatches(s: dict, again: dict) -> List[str]:
    """Provenance check: the summary's provider, model and fake/real label must be those of its own records."""
    out = []
    if again["providers"] != [s.get("provider")]:
        out.append("the summary's provider %r is not the records' %s" % (s.get("provider"), again["providers"]))
    if again["models_requested"] != [str(s.get("model_requested"))]:
        out.append("the summary's model_requested %r is not the records' %s" % (s.get("model_requested"), again["models_requested"]))
    if canonical_json(again["models_served"]) != canonical_json(s.get("models_served")):
        out.append("the summary's models_served %s is not the records' %s" % (s.get("models_served"), again["models_served"]))
    if s.get("summary_format") == WF.SUMMARY_FORMAT:
        if not isinstance(s.get("workflow"), dict) or bool(s.get("fake_run")) != bool(s["workflow"].get("fake")) or \
                again["providers"] != ["workflow:%s" % s["workflow"].get("name")] or s.get("workflow_fingerprint") != WF.workflow_fingerprint(s["workflow"]):
            out.append("the summary's workflow description, fingerprint or fake/real label does not match its records")
    elif bool(s.get("fake_run")) != (again["providers"] == ["fake"]):
        out.append("the summary says fake_run=%s but the records come from provider(s) %s" % (s.get("fake_run"), again["providers"]))
    return out


def resummarise(recs: List[dict], s: dict) -> dict:
    """The summary's counts recomputed from its records, for a chain run or a whole-workflow run."""
    if s.get("summary_format") == WF.SUMMARY_FORMAT:
        conds = s.get("conditions")
        if not isinstance(conds, list) or not conds or any(c not in WF.CONDITIONS for c in conds):
            raise ValueError("unknown workflow conditions %r" % (conds,))
        return WF.summarise_workflow(recs, conds)
    return summarise_chain(recs)


def summary_problems(s: dict) -> List[str]:
    """Internal consistency of a summary on its own: every cell holds exactly runs x orders decisions (fewer only when
    the run is marked incomplete), and paired counts never exceed their cases."""
    try:
        per = (s.get("runs_requested") or 0) * len(s.get("orders_requested") or [])
        for cond, dirs in s["counts"].items():
            for d, k in dirs.items():
                n = sum(k.values())
                if any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in k.values()) or n > per or (n != per and not s.get("incomplete")):
                    return ["the summary's counts are impossible: %s/%s holds %s decisions, but %s run(s) x %s order(s) give %d"
                            % (cond, d, n, s.get("runs_requested"), len(s.get("orders_requested") or []), per)]
        for cond, p in s["paired"].items():
            if not (0 <= p["both_priorities_got_their_own_option"] <= p["readable_cases"] <= p["cases"] <= per):
                return ["the summary's paired counts are impossible for %s" % cond]
    except (AttributeError, KeyError, TypeError):
        return ["the summary's counts are malformed"]
    return []


def _response_id(ex):
    r = ex.get("response") if isinstance(ex, dict) else None
    return (r.get("id") or r.get("responseId")) if isinstance(r, dict) else None


def _between(text, a, b):
    i = text.find(a) if isinstance(text, str) else -1
    if i < 0:
        return None
    j = text.find(b, i + len(a))
    return None if j < 0 else text[i + len(a):j]


def scenario_from_records(recs: List[dict]):
    """The scenario fields as the records show them (handoff-1 prompts and target options). The question and context
    are joined by a newline in the prompts, so every split is returned as a candidate."""
    sc = {"scenario_id": recs[0].get("scenario_id") if recs else None}
    task = None
    for x in recs:
        d = x.get("direction")
        if x.get("target_option_text") and d in DIRECTIONS:
            sc["option_" + d.lower()] = x["target_option_text"]
        if x.get("kind") == "handoff" and x.get("handoff") == 1 and x.get("chain_arm") == "with_priority" and isinstance(x.get("prompt"), str):
            sc.setdefault("priority_" + d, _between(x["prompt"], "What they have told you matters to them:\n", "\n\nTheir situation:"))
            if x.get("order") == "as_given" or task is None:
                task = _between(x["prompt"], "TASK: ", "\nOPTION A: ")
    if task is None:
        return []
    splits = [(task, None)] + [(task[:i], task[i + 1:]) for i, ch in enumerate(task) if ch == "\n"]
    out = []
    for q, ctx in splits:
        c = dict(sc, question=q)
        if ctx is not None:
            c["context"] = ctx
        out.append(c)
    return out


def record_problems(recs: List[dict], s: dict) -> List[str]:
    """Consistency checks on verified records (they are not signed, so these catch edits, not every forgery):
    every answer re-parsed with the kit's strict parser and re-scored; the scenario sha256 recomputed from the
    scenario text in the records; one record per planned call (no duplicates, runs and orders as requested, times in
    order); one run id; and, for a real run, the exact request and raw response on every call that was made."""
    out = []
    for x in recs:
        if x.get("kind") != "decision":
            continue
        ok = x.get("error") is None and isinstance(x.get("response_text"), str)
        if not ok:
            if x.get("outcome") != "MISSING":
                out.append("a failed call is scored %s, not MISSING (record %s/%s)" % (x.get("outcome"), x.get("condition"), x.get("direction")))
            continue
        letter = parse_strict(x["response_text"])
        shown = {"A": x.get("option_a_shown"), "B": x.get("option_b_shown")}
        want = ("INVALID" if letter == "INVALID" else "UNCLEAR" if letter == "UNCLEAR"
                else "MATCHED" if shown.get(letter) == x.get("target_option_text") else "OPPOSITE")
        if letter != x.get("parsed") or want != x.get("outcome") or (letter in ("A", "B") and x.get("chosen_option_text") != shown.get(letter)):
            out.append("a recorded answer does not give its recorded outcome when re-read (%s, priority favours %s, run %s, %s): "
                       "the answer reads %s, the record says %s" % (x.get("condition"), x.get("direction"), x.get("run"), x.get("order"),
                                                                   letter, x.get("outcome")))
            break
    if s.get("summary_format") == WF.SUMMARY_FORMAT:
        sc = s.get("scenario")
        try:
            ok_sc = isinstance(sc, dict) and scenario_sha256(sc) == s.get("scenario_sha256")
        except (ScenarioError, TypeError, AttributeError):
            ok_sc = False
        tgt = {"A": sc.get("option_a"), "B": sc.get("option_b")} if isinstance(sc, dict) else {}
        out += workflow_record_problems(recs, s, sc if ok_sc else None)
        if not ok_sc or any(x.get("kind") == "decision" and (x.get("target_option_text") != tgt.get(x.get("direction")) or
                            {x.get("option_a_shown"), x.get("option_b_shown")} != set(tgt.values())) for x in recs):
            out.append("scenario_sha256 does not match the scenario text in the records (the summary's scenario hash was changed, or the records belong to another scenario)")
        cands = []
    else:
        cands = scenario_from_records(recs)
    shas = set()
    for c in cands:
        try:
            shas.add(scenario_sha256(c))
        except (ScenarioError, TypeError, AttributeError):
            pass
    if s.get("summary_format") != WF.SUMMARY_FORMAT and s.get("scenario_sha256") not in shas:
        out.append("scenario_sha256 does not match the scenario text in the records (the summary's scenario hash was changed, or the records belong to another scenario)")
    keys = set()
    for x in recs:
        k = (x.get("kind"), x.get("run"), x.get("order"), x.get("direction"), x.get("chain_arm") if x.get("kind") == "handoff" else x.get("condition"), x.get("handoff"))
        if k in keys:
            out.append("a call appears twice in the records (%s, run %s, %s, priority favours %s): duplicated records are not repeats" % (k[0], k[1], k[2], k[3]))
            break
        keys.add(k)
    runs = s.get("runs_requested")
    if any(not isinstance(x.get("run"), int) or isinstance(x.get("run"), bool) or not (0 <= x["run"] < (runs or 0)) for x in recs):
        out.append("a record's run number is outside the %s run(s) requested" % runs)
    if any(x.get("order") not in (s.get("orders_requested") or []) for x in recs):
        out.append("a record's option order was not requested")
    if len({x.get("run_id") for x in recs}) != 1 or (recs and recs[0].get("run_id") != s.get("run_id")):
        out.append("the records do not all carry the summary's run id")
    starts = [x.get("t_start") for x in recs if x.get("t_start") is not None]
    if any(not isinstance(t, str) for t in starts) or any(b < a for a, b in zip(starts, starts[1:])):
        out.append("call start times go backwards in the records (records were reordered, copied or appended)")
    if not s.get("fake_run") and s.get("summary_format") != WF.SUMMARY_FORMAT:
        made = [x for x in recs if x.get("t_start") is not None]
        if any(not isinstance(x.get("exchange"), dict) or not isinstance(x["exchange"].get("request_body"), dict) or "response" not in x["exchange"] for x in made):
            out.append("a real run's record lacks the exact request and raw response the kit stores for every call made")
        ids = [i for i in (_response_id(x.get("exchange")) for x in made) if i]
        if len(ids) != len(set(ids)):
            out.append("two calls carry the same provider response id: records were copied, not made by separate calls")
    return out


def workflow_record_problems(recs: List[dict], s: dict, sc) -> List[str]:
    """Whole-workflow runs: the summary's conditions, NOT SUPPORTED list, configuration and exposure checks must be those
    of its own records, and every recorded exposure check must follow from its trace."""
    out = []
    conds, ns = s.get("conditions") or [], s.get("not_supported") or []
    sup = ((s.get("workflow") or {}).get("supports") or {})
    if set(conds) & set(ns) or sorted(ns) != sorted(c for c in WF.OPTIONAL if c not in conds) or \
            any(bool(sup.get(c)) != (c in conds) for c in WF.OPTIONAL):
        out.append("the summary's conditions, NOT SUPPORTED list and the adapter's supports do not agree")
    if any(x.get("condition") not in conds for x in recs):
        out.append("records contain a condition the summary does not list (e.g. one marked NOT SUPPORTED)")
    ex = [x for x in recs if x.get("kind") == "execution"]
    if any(canonical_json((x.get("request") or {}).get("config")) != canonical_json(s.get("config")) for x in ex):
        out.append("the summary's configuration is not the configuration recorded in its executions' requests")
    if sc is not None:
        pri = {"A": sc["priority_A"], "B": sc["priority_B"]}
        for x in ex:
            q = x.get("request") or {}
            want = None if x.get("condition") == "workflow_no_priority" else pri.get(x.get("direction"))
            if q.get("priority") != want or q.get("condition") != x.get("condition") or q.get("order") != x.get("order"):
                out.append("an execution's recorded request does not match its condition (priority, order or condition)")
                break
        out += WF.recheck_exposure(recs, sc)
        if canonical_json(WF.exposure_summary(recs)) != canonical_json(s.get("exposure_checks")):
            out.append("the summary's exposure checks are not those of its own records")
    return out


def _times_sha(recs: List[dict]) -> str:
    return sha256_bytes(canonical_json([x.get("t_start") for x in recs]))


def _dict_diffs(field, a, b) -> List[dict]:
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            va, vb = a.get(k, "<absent>"), b.get(k, "<absent>")
            if canonical_json(va) != canonical_json(vb):
                out.append({"field": "%s.%s" % (field, k), "baseline": va, "candidate": vb})
        return out
    return [{"field": field, "baseline": a, "candidate": b}]


def differences(b: dict, c: dict) -> List[dict]:
    """Every detected difference, each with its class (INVALID or CHANGED). Empty list = same configuration."""
    diffs = []
    for field, label, cls in FIELDS:
        va, vb = b.get(field), c.get(field)
        if field == "settings" and (va is None or vb is None):
            diffs.append({"field": "settings", "baseline": va, "candidate": vb, "class": INVALID,
                          "message": "settings were not recorded for at least one run, so they cannot be checked"})
            continue
        if canonical_json(va) != canonical_json(vb):
            for d in _dict_diffs(field, va, vb):
                d["message"], d["class"] = "%s not the same in both runs" % label, cls
                diffs.append(d)
    if b.get("fake_run") != c.get("fake_run"):
        diffs[0]["message"] = "a fake run and a real run are never comparable"
    for name, s in (("baseline", b), ("candidate", c)):
        if s.get("incomplete") or s.get("calls_recorded") != s.get("planned_calls"):
            diffs.append({"field": "%s.complete" % name, "baseline": None, "candidate": None, "class": INVALID,
                          "message": "%s run is incomplete (%d of %d planned calls recorded%s)" % (
                              name, s.get("calls_recorded") or 0, s.get("planned_calls") or 0,
                              ("; " + s["incomplete"]) if s.get("incomplete") else "")})
    for name, x in (("baseline", b), ("candidate", c)):
        e = x.get("exposure_checks") or {}
        if e.get("no_priority_executions_with_priority_text") or e.get("priority_executions_with_opposite_priority_text") or e.get("executions_with_earlier_execution_output"):
            diffs.append({"field": "%s.exposure_checks" % name, "baseline": None, "candidate": None, "class": INVALID,
                          "message": "%s run: text was found where it should not be (%d no-priority execution(s) with a priority, %d with the "
                                     "opposite priority, %d with an earlier execution's output): executions were not independent or the control "
                                     "was contaminated" % (name, e.get("no_priority_executions_with_priority_text") or 0,
                                                           e.get("priority_executions_with_opposite_priority_text") or 0,
                                                           e.get("executions_with_earlier_execution_output") or 0)})
    if b.get("run_id") and b.get("run_id") == c.get("run_id") and b.get("records_sha256") != c.get("records_sha256"):
        diffs.append({"field": "run_id", "baseline": b.get("run_id"), "candidate": c.get("run_id"), "class": INVALID,
                      "message": "both runs carry the same run id but different records: at least one was edited or relabelled"})
    if b.get("records_sha256") == c.get("records_sha256"):
        diffs.append({"field": "records_sha256", "baseline": b.get("records_sha256"), "candidate": c.get("records_sha256"), "class": INVALID,
                      "message": "both sides are the same run (identical records): a repeatability check needs two separate runs"})
    return diffs


def unverified_diffs(baseline: dict, candidate: dict) -> List[dict]:
    return [{"field": "%s.records" % n, "baseline": None, "candidate": None, "class": INVALID,
             "message": "%s: only a summary was given, so its counts could not be checked against its records (give the run folder or a saved result)" % n}
            for n, r in (("baseline", baseline), ("candidate", candidate)) if not r["records_verified"]]


def validity(b: dict, c: dict) -> List[dict]:
    """r1 API: every difference (any difference made r1 runs 'not comparable')."""
    return differences(b, c)


def classify(diffs: List[dict]) -> str:
    return INVALID if any(d["class"] == INVALID for d in diffs) else CHANGED if diffs else SAME


def headline(verdict: str, diffs: List[dict], workflow_pair: bool = False) -> str:
    if verdict == SAME:
        return "Same configuration: no recorded difference. Suitable for looking at repeatability and run-to-run variation."
    if verdict == INVALID:
        return "Not a valid controlled comparison: %s." % "; ".join(d["message"] for d in diffs if d["class"] == INVALID)
    mf = tuple(f for f in MODEL_FIELDS if not (workflow_pair and f == "provider"))   # a workflow's provider is its adapter label
    model = [d for d in diffs if d["field"].split(".")[0] in mf]
    other = [d for d in diffs if d["field"].split(".")[0] not in mf]
    if model:
        return ("Model changed, with the following accompanying configuration differences: %s." % ", ".join(d["field"] for d in other)
                if other else "Model changed. No other recorded configuration difference was detected (unrecorded "
                "factors, such as provider-side changes behind the same settings, cannot be ruled out).")
    return "Configuration changed: %s." % ", ".join(d["field"] for d in diffs)


def repetitions(s: dict) -> dict:
    """What one side's counts rest on. All decisions come from one scenario: runs and orders are repeated samples."""
    per = {}
    for cond in s["counts"]:
        for d, k in s["counts"][cond].items():
            per["%s/%s" % (cond, d)] = {"decisions": sum(k.values()), "usable": sum(v for o, v in k.items() if o != "MISSING")}
    usable = [v["usable"] for v in per.values()] or [0]
    one = sum(1 for cond in s["counts"] for k in s["counts"][cond].values() if sum(k.values()) and max(k.values()) == sum(k.values()))
    cells = sum(1 for cond in s["counts"] for k in s["counts"][cond].values() if sum(k.values()))
    return {"scenarios": 1, "runs_requested": s.get("runs_requested"), "runs_recorded": s.get("runs"),
            "orders": s.get("orders_requested"), "decisions_per_condition_and_direction": max(v["decisions"] for v in per.values()) if per else 0,
            "fewest_usable_decisions_in_a_cell": min(usable),
            "cells_where_every_repetition_gave_the_same_outcome": one, "cells": cells}


def parse_rule(text: str) -> dict:
    parts = text.split(":")
    if len(parts) not in (2, 3):
        raise Refused("--fail-on-drop %r: use CONDITION:N or CONDITION:DIRECTION:N" % text)
    cond, n = parts[0], parts[-1]
    direction = parts[1] if len(parts) == 3 else None
    if cond not in CONDITIONS:
        raise Refused("--fail-on-drop %r: condition must be one of %s" % (text, ", ".join(CONDITIONS)))
    if direction is not None and direction not in DIRECTIONS:
        raise Refused("--fail-on-drop %r: direction must be A or B" % text)
    if not n.isdigit():
        raise Refused("--fail-on-drop %r: N must be a whole number of 0 or more" % text)
    return {"rule": text, "condition": cond, "direction": direction or "both", "max_drop": int(n)}


def _matched(s: dict, cond: str, direction: str) -> int:
    ds = DIRECTIONS if direction == "both" else (direction,)
    return sum(s["counts"][cond][d]["MATCHED"] for d in ds)


def compare(baseline: dict, candidate: dict, rules=()) -> dict:
    """baseline/candidate: as returned by load_run. rules: as returned by parse_rule. Returns the full comparison."""
    b, c = baseline["summary"], candidate["summary"]
    diffs = differences(b, c) + unverified_diffs(baseline, candidate)
    tb, tc = baseline.get("records_times_sha256"), candidate.get("records_times_sha256")
    if tb and tb == tc and b.get("records_sha256") != c.get("records_sha256"):
        diffs.append({"field": "records.t_start", "baseline": None, "candidate": None, "class": INVALID,
                      "message": "both runs have identical call times: one is a relabelled copy of the other, not a separate run"})
    verdict = classify(diffs)
    comparable = verdict != INVALID
    conds = [x for x in (b.get("conditions") or CONDITIONS) if x in b["counts"] and x in c["counts"]]
    counts, paired = [], []
    for cond in conds:
        for d in DIRECTIONS:
            kb, kc = b["counts"][cond][d], c["counts"][cond][d]
            counts.append({"condition": cond, "direction": d, "baseline": {o: kb[o] for o in OUTCOMES},
                           "candidate": {o: kc[o] for o in OUTCOMES}, "change": {o: kc[o] - kb[o] for o in OUTCOMES}})
        pb, pc = b["paired"][cond], c["paired"][cond]
        keys = ("cases", "readable_cases", "both_priorities_got_their_own_option")
        paired.append({"condition": cond, "baseline": {k: pb[k] for k in keys}, "candidate": {k: pc[k] for k in keys},
                       "change": {k: pc[k] - pb[k] for k in keys}})
    evaluated = []
    for r in rules:
        mb, mc = _matched(b, r["condition"], r["direction"]), _matched(c, r["condition"], r["direction"])
        evaluated.append(dict(r, baseline_matched=mb, candidate_matched=mc, drop=mb - mc,
                              tripped=(mb - mc > r["max_drop"]) if comparable else None))
    reps = {"baseline": repetitions(b), "candidate": repetitions(c)}
    notes = ["Descriptive counts only. No statistical test is run and no significance is claimed. The kit has no "
             "pass/fail threshold; any rule shown is the developer's own, set in advance.",
             "UNCLEAR, INVALID and MISSING are kept separate and never counted as OPPOSITE.",
             "All decisions come from one scenario: repeated runs and the two option orders are repeated samples of the "
             "same scenario, not additional independent scenarios. Nothing here generalises to other decisions.",
             ("Both runs tested the workflow your adapter ran, as the adapter describes it (whole-workflow test)."
              if b.get("summary_format") == WF.SUMMARY_FORMAT and c.get("summary_format") == WF.SUMMARY_FORMAT else
              "Both runs tested the kit's FIXED six-handoff reference workflow, not your own agents."
              if b.get("summary_format") != WF.SUMMARY_FORMAT and c.get("summary_format") != WF.SUMMARY_FORMAT else
              "One run tested the kit's fixed reference workflow and the other a workflow through an adapter.")]
    if min(b.get("runs_requested") or 1, c.get("runs_requested") or 1) == 1:
        notes.insert(0, REPEAT_WARNING + " One run per case on at least one side: the same prompt can give a different "
                     "answer when called again, so even an unchanged system can show changes. Use --runs 2 or more on both.")
    if verdict == CHANGED and len({d["field"].split(".")[0] if d["field"].split(".")[0] not in MODEL_FIELDS else "model" for d in diffs}) > 1:
        notes.append("More than one thing changed, so no single change (including the model) can be credited with any "
                     "difference in the counts.")
    if b.get("runs_requested") != c.get("runs_requested"):
        notes.append("The two sides have different numbers of repetitions: compare each count with its own total, not raw counts.")
    adv = [(n, (x.get("exposure_checks") or {}).get("executions_with_unrecorded_source_suspected") or 0) for n, x in (("baseline", b), ("candidate", c))]
    if any(v for _, v in adv):
        notes.append("ADVISORY (does not invalidate): possible unrecorded source of earlier-execution text (" + ", ".join(
            "%s: %d execution(s)" % (n, v) for n, v in adv if v) + "): an unrecorded memory, cache or session history, or legitimately "
            "shared text. Check those agents' traces before relying on this comparison.")
    if b.get("fake_run") or c.get("fake_run"):
        notes.append("FAKE MODEL OUTPUT IS NOT EVIDENCE: at least one run used fake (offline) models; its numbers "
                     "say nothing about any real model.")
    eb, ec_ = (b.get("exposure_checks") or {}).get("workflow_priority_found_by_agent"), (c.get("exposure_checks") or {}).get("workflow_priority_found_by_agent")
    if eb is not None and ec_ is not None and canonical_json(eb) != canonical_json(ec_):
        z = {"model request": 0, "visible state only": 0}
        notes.append("Per-agent exposure changed (where the given priority's exact text was found, whole-workflow executions): " + "; ".join(
            "%s: in its request %d -> %d, only in state %d -> %d" % (k, eb.get(k, z)["model request"], ec_.get(k, z)["model request"],
                                                                  eb.get(k, z)["visible state only"], ec_.get(k, z)["visible state only"])
            for k in sorted(set(eb) | set(ec_)) if canonical_json(eb.get(k, z)) != canonical_json(ec_.get(k, z))) +
            ". Exact text only: a paraphrase is not counted.")
    for name, run in (("baseline", baseline), ("candidate", candidate)):
        if not run["records_verified"]:
            notes.append("%s: a summary file was given, not its run directory, so its records.jsonl was not checked "
                         "against it." % name)
    if b.get("kit_version") != c.get("kit_version"):
        notes.append("Kit versions differ (%s vs %s). The prompt templates are checked by sha256; a change to the "
                     "answer parser would not be detected." % (b.get("kit_version"), c.get("kit_version")))
    if not comparable:
        notes.append("NOT A VALID CONTROLLED COMPARISON: the side-by-side counts are descriptive only. Changes may come "
                     "from the listed differences, not from the change you meant to test.")
    code = (EXIT_NOT_COMPARABLE if not comparable else EXIT_RULE if any(e["tripped"] for e in evaluated)
            else EXIT_CHANGED if verdict == CHANGED else EXIT_OK)
    wfp = b.get("summary_format") == WF.SUMMARY_FORMAT and c.get("summary_format") == WF.SUMMARY_FORMAT
    return {"format": COMPARE_FORMAT, "verdict": verdict, "headline": headline(verdict, diffs, wfp),
            "model_changed": any(d["field"].split(".")[0] in MODEL_FIELDS and not (wfp and d["field"].split(".")[0] == "provider") for d in diffs), "repetitions": reps,
            "differences": diffs, "exit_code": code, "rules_evaluated": comparable, "rules": evaluated,
            "baseline": {"source": baseline["source"], "records_verified": baseline["records_verified"],
                         "identity": {k: b.get(k) for k in IDENTITY_FIELDS}},
            "candidate": {"source": candidate["source"], "records_verified": candidate["records_verified"],
                          "identity": {k: c.get(k) for k in IDENTITY_FIELDS}},
            "counts": counts, "paired": paired, "notes": notes}


def _short(v) -> str:
    t = json.dumps(v, sort_keys=True, ensure_ascii=False)
    return t if len(t) <= 80 else t[:77] + "..."


def _chg(n: int) -> str:
    return "%+d" % n if n else "0"


def render_text(r: dict) -> str:
    L = ["Comparison of two runs (descriptive only)",
         "baseline : %s (records verified: %s)" % (r["baseline"]["source"], "yes" if r["baseline"]["records_verified"] else "NO"),
         "candidate: %s (records verified: %s)" % (r["candidate"]["source"], "yes" if r["candidate"]["records_verified"] else "NO")]
    i = r["baseline"]["identity"]
    j = r["candidate"]["identity"]
    L.append("scenario %s (sha256 %s); baseline: provider %s, model %s, runs per case %s, orders %s; candidate: provider %s, "
             "model %s, runs per case %s, orders %s" % (
        i["scenario_id"], (i["scenario_sha256"] or "")[:16], i["provider"], i["model_requested"], i["runs_requested"],
        ",".join(i["orders_requested"] or []), j["provider"], j["model_requested"], j["runs_requested"], ",".join(j["orders_requested"] or [])))
    L += ["", "VERDICT: %s" % VERDICT_LABELS[r["verdict"]], r["headline"]]
    fb, fc = r["baseline"]["identity"].get("fake_run"), r["candidate"]["identity"].get("fake_run")
    if fb or fc:
        L.append("FAKE MODEL OUTPUT %s: NOT EVIDENCE about any model." % ("ON BOTH SIDES" if fb and fc else "ON ONE SIDE"))
    if r["differences"]:
        L.append("Every detected difference (%d):" % len(r["differences"]))
        for d in r["differences"]:
            vals = "" if d["baseline"] is None and d["candidate"] is None else "; baseline %s, candidate %s" % (_short(d["baseline"]), _short(d["candidate"]))
            L.append("  - [%s] %s: %s%s" % ("invalidates" if d["class"] == INVALID else "configuration", d["field"], d["message"], vals))
    if r["verdict"] == INVALID:
        L.append("The side-by-side below is DESCRIPTIVE ONLY and must not be read as the effect of your change.")
    L += ["", "Repetitions (one scenario; runs and option orders are repeated samples of it, not independent scenarios):"]
    for side in ("baseline", "candidate"):
        x = r["repetitions"][side]
        L.append("  %-9s runs requested %s, runs recorded %s, orders %s: %s decisions per condition and direction "
                 "(fewest usable in a cell: %s)" % (side, x["runs_requested"], x["runs_recorded"], ",".join(x["orders"] or []),
                                                    x["decisions_per_condition_and_direction"], x["fewest_usable_decisions_in_a_cell"]))
    L += ["", "Counts per condition and priority direction: baseline -> candidate (change); n = decisions in the cell",
          "%-19s %-3s %s %s" % ("condition", "dir", "".join("%-15s" % o for o in OUTCOMES), "n")]
    for x in r["counts"]:
        L.append("%-19s %-3s %s %d->%d" % (x["condition"], x["direction"], "".join(
            "%-15s" % ("%d->%d (%s)" % (x["baseline"][o], x["candidate"][o], _chg(x["change"][o]))) for o in OUTCOMES),
            sum(x["baseline"].values()), sum(x["candidate"].values())))
    L += ["", "Paired: both opposing priorities got their own option (of readable cases / cases)",
          "%-19s %-18s %-18s %s" % ("condition", "baseline", "candidate", "change")]
    for x in r["paired"]:
        f = lambda s: "%d of %d (%d cases)" % (s["both_priorities_got_their_own_option"], s["readable_cases"], s["cases"])
        if x["condition"] == "workflow_no_priority":     # one shared execution per case: no pair can be formed
            L.append("%-19s %s" % (x["condition"], "not applicable: one shared execution per case (no priority given)"))
            continue
        L.append("%-19s %-18s %-18s %s" % (x["condition"], f(x["baseline"]), f(x["candidate"]),
                                            _chg(x["change"]["both_priorities_got_their_own_option"])))
    if r["rules"]:
        L += ["", "Your own pre-set rules (--fail-on-drop; not a kit threshold):"]
        for e in r["rules"]:
            state = ("not evaluated (not a valid controlled comparison)" if e["tripped"] is None else "TRIPPED" if e["tripped"] else "not tripped")
            L.append("  %s: MATCHED in %s (%s) %d -> %d, drop %d, allowed %d: %s" % (
                e["rule"], e["condition"], e["direction"], e["baseline_matched"], e["candidate_matched"], e["drop"], e["max_drop"], state))
    L += ["", "Notes:"] + ["  - " + n for n in r["notes"]]
    return "\n".join(L)


def add_compare_parser(sub):
    c = sub.add_parser("compare", help="compare a new chain or workflow run with an earlier one", description=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    c.add_argument("--baseline", required=True, help="earlier run: its --out directory (preferred) or its summary.json")
    c.add_argument("--candidate", required=True, help="new run: its --out directory (preferred) or its summary.json")
    c.add_argument("--json", help="also write the full comparison as JSON to this new file (never overwritten)")
    c.add_argument("--fail-on-drop", action="append", default=[], metavar="CONDITION[:DIRECTION]:N",
                   help="YOUR pre-set rule: exit 1 if MATCHED in CONDITION drops by more than N (repeatable)")
    return c


def main_compare(a) -> int:
    try:
        rules = [parse_rule(t) for t in a.fail_on_drop]
        if a.json and pathlib.Path(a.json).exists():
            raise Refused("--json %s exists; choose a new file" % a.json)
        r = compare(load_run(a.baseline), load_run(a.candidate), rules)
        if a.json:
            with open(a.json, "x", encoding="utf-8") as f:
                f.write(json.dumps(r, indent=1, ensure_ascii=False) + "\n")
    except Refused as e:
        print("refused: %s" % e, file=sys.stderr)
        return EXIT_REFUSED
    print(render_text(r))
    if a.json:
        print("comparison JSON: %s" % a.json)
    print("exit code %d (%s)" % (r["exit_code"], {0: "same configuration, no rule of yours tripped", 1: "a rule of yours tripped",
                                                  3: "configuration change, no rule of yours tripped",
                                                  5: "not a valid controlled comparison"}[r["exit_code"]]))
    return r["exit_code"]
