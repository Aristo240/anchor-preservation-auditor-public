"""Offline tests for the `compare` subcommand and the run identity in the chain summary. No network: socket connections
raise during every test. Only the fake provider is run; a 'real' run is simulated by editing a summary (and, where the
records must verify, by rewriting its records sha256)."""
import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from priority_check import chain as ch   # noqa: E402
from priority_check import compare as cmp   # noqa: E402
from priority_check import __main__ as cli   # noqa: E402
from priority_check.providers import FakeChainProvider   # noqa: E402

EXAMPLE = ROOT / "examples" / "chain_scenario.example.json"
SC = ch.load_scenario(EXAMPLE)
BASELINE_EXAMPLE = ROOT / "examples" / "ci_baseline_fake"


class NoNetwork(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        p = mock.patch("socket.create_connection", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)

    def p(self, name):
        return os.path.join(self.tmp.name, name)

    def cli(self, *args):
        o, e = io.StringIO(), io.StringIO()
        with redirect_stdout(o), redirect_stderr(e):
            code = cli.main(list(args))
        return code, o.getvalue(), e.getvalue()

    def chain(self, name, *extra, scenario=EXAMPLE):
        code, _, err = self.cli("chain", "--scenario", str(scenario), "--provider", "fake", "--out", self.p(name), *extra)
        self.assertEqual(code, 0, err)
        return self.p(name)

    def compare(self, base, cand, *extra):
        return self.cli("compare", "--baseline", base, "--candidate", cand, *extra)

    def edit_summary(self, d, fn, rehash_records=False):
        sp = os.path.join(d, "summary.json")
        with open(sp, encoding="utf-8") as f:
            s = json.load(f)
        fn(s)
        if rehash_records:
            s["records_sha256"] = ch.file_sha256(os.path.join(d, "records.jsonl"))
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(s, f, indent=1)

    def relabel(self, d, provider, model, fake, **summary_fields):
        """TEST FIXTURE ONLY: rewrites a fake run's records and summary as if another provider/model had served it,
        consistently (records rehashed), so `compare` can be exercised on model changes without any real call. The
        counts are still the fake's: nothing here is evidence about any model."""
        rp = os.path.join(d, "records.jsonl")
        with open(rp, encoding="utf-8") as f:
            recs = [json.loads(x) for x in f if x.strip()]
        for r in recs:
            r.update(provider=provider, model_requested=model, model_served=model)
            if not fake and r.get("t_start") is not None:   # a real record carries the exact request and raw response
                r["exchange"] = {"request_body": {"fixture": True}, "response": {"fixture": True}}
        with open(rp, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(r) + "\n" for r in recs))
        def fn(s):
            s.update(provider=provider, model_requested=model, models_served=[model], models_requested=[model],
                     providers=[provider], fake_run=fake, **summary_fields)
            if not fake:
                s.pop("fake_note", None)
        self.edit_summary(d, fn, rehash_records=True)


class SummaryIdentity(NoNetwork):
    def test_summary_holds_everything_compare_needs_and_old_fields(self):
        d = self.chain("r")
        s = json.loads(pathlib.Path(d, "summary.json").read_text())
        for k in cmp.REQUIRED_FIELDS:
            self.assertIn(k, s)
        for k in ("calls_recorded", "decision_calls", "handoff_calls", "providers", "models_requested", "models_served",
                  "runs", "orders", "counts", "paired"):   # existing fields kept
            self.assertIn(k, s)
        self.assertTrue(s["fake_run"]); self.assertIn("NOT EVIDENCE", s["fake_note"])
        self.assertEqual(s["scenario_sha256"], ch.scenario_sha256(SC))
        self.assertEqual(s["records_sha256"], ch.file_sha256(pathlib.Path(d, "records.jsonl")))
        self.assertEqual(s["settings"]["drift_after"], None)
        self.assertEqual(s["orders_requested"], ["as_given", "swapped"]); self.assertEqual(s["runs_requested"], 1)
        self.assertEqual(s["conditions"], list(ch.CONDITIONS))
        self.assertNotIn("api_key_env", json.dumps(s))

    def test_committed_example_baseline_is_a_verifiable_fake_run(self):
        run = cmp.load_run(BASELINE_EXAMPLE)
        self.assertTrue(run["records_verified"]); self.assertTrue(run["summary"]["fake_run"])
        self.assertIn("FAKE MODEL OUTPUT IS NOT EVIDENCE", (BASELINE_EXAMPLE / "report.md").read_text())


class Verdict(NoNetwork):
    def test_identical_fake_runs_are_comparable(self):
        a, b = self.chain("a"), self.chain("b")
        code, out, err = self.compare(a, b)
        self.assertEqual(code, 0, err)
        self.assertIn("VERDICT: SAME CONFIGURATION", out)
        self.assertIn("FAKE MODEL OUTPUT IS NOT EVIDENCE", out)
        self.assertIn(cmp.REPEAT_WARNING, out)
        self.assertIn("No statistical test", out)
        self.assertIn("not additional independent scenarios", out)
        self.assertIn("runs requested 1, runs recorded 1, orders as_given,swapped: 2 decisions per condition and direction", out)

    def test_repeated_runs_have_no_single_run_warning_and_count_samples_not_scenarios(self):
        a, b = self.chain("a", "--runs", "3"), self.chain("b", "--runs", "3")
        r = cmp.compare(cmp.load_run(a), cmp.load_run(b))
        self.assertEqual(r["verdict"], cmp.SAME)
        self.assertFalse(any(cmp.REPEAT_WARNING in n for n in r["notes"]))
        self.assertEqual(r["repetitions"]["baseline"], {"scenarios": 1, "runs_requested": 3, "runs_recorded": 3,
                         "orders": ["as_given", "swapped"], "decisions_per_condition_and_direction": 6,
                         "fewest_usable_decisions_in_a_cell": 6, "cells_where_every_repetition_gave_the_same_outcome": 10, "cells": 10})
        one = self.chain("one")
        r = cmp.compare(cmp.load_run(a), cmp.load_run(one))
        self.assertEqual(r["verdict"], cmp.CHANGED)                       # the number of repetitions is a listed change
        self.assertEqual([d["field"] for d in r["differences"]], ["runs_requested"])
        self.assertTrue(r["notes"][0].startswith(cmp.REPEAT_WARNING))     # one side has one run
        self.assertTrue(any("compare each count with its own total" in n for n in r["notes"]))

    def test_changed_scenario_is_not_comparable(self):
        sc2 = dict(json.loads(EXAMPLE.read_text()), context="The budget differs between the options.")
        p2 = self.p("s2.json")
        with open(p2, "w") as f:
            json.dump(sc2, f)
        a, b = self.chain("a"), self.chain("b", scenario=p2)
        code, out, _ = self.compare(a, b)
        self.assertEqual(code, 5)
        self.assertIn("NOT A VALID CONTROLLED COMPARISON", out); self.assertIn("scenario_sha256", out)
        self.assertIn("DESCRIPTIVE ONLY", out)
        self.assertIn("Counts per condition", out)   # the side-by-side is still printed

    def test_changed_fake_setting_is_a_settings_difference(self):
        a, b = self.chain("a"), self.chain("b", "--fake-drift-after", "3")
        code, out, _ = self.compare(a, b)
        self.assertEqual(code, 3); self.assertIn("settings.drift_after", out)
        self.assertIn("VERDICT: CONFIGURATION CHANGE", out); self.assertIn("Configuration changed: settings.drift_after.", out)

    def test_changed_orders_and_runs_are_listed(self):
        a, b = self.chain("a"), self.chain("b", "--orders", "as_given", "--runs", "2")
        code, out, _ = self.compare(a, b, "--json", self.p("c.json"))
        self.assertEqual(code, 5)
        fields = {d["field"] for d in json.loads(pathlib.Path(self.p("c.json")).read_text())["differences"]}
        self.assertTrue({"orders_requested", "runs_requested"} <= fields, fields)

    def test_model_change_lists_every_accompanying_difference(self):
        """Gemini -> Claude (both labelled real, fixture only): the model change AND the settings, request parameters
        and provider that came with it are all listed; it is never presented as an isolated model effect."""
        a, b = self.chain("a"), self.chain("b")
        self.relabel(a, "gemini", "gemini-2.5-pro", False,
                     settings={"max_tokens": 8192, "temperature": 0.2, "thinking": "includeThoughts"},
                     request_parameters_sent=[{"generationConfig": {"maxOutputTokens": 8192, "temperature": 0.2}}])
        self.relabel(b, "anthropic", "claude-sonnet-5-5", False,
                     settings={"max_tokens": 16384, "sampling_parameters": "none sent (provider defaults)", "anthropic_version": "2023-06-01"},
                     request_parameters_sent=[{"max_tokens": 16384, "model": "claude-sonnet-5-5"}])
        code, out, _ = self.compare(a, b, "--json", self.p("c.json"))
        self.assertEqual(code, 3)
        r = json.loads(pathlib.Path(self.p("c.json")).read_text())
        self.assertEqual(r["verdict"], cmp.CHANGED); self.assertTrue(r["model_changed"])
        fields = [d["field"] for d in r["differences"]]
        for f in ("provider", "model_requested", "models_served", "settings.max_tokens", "settings.temperature",
                  "settings.thinking", "settings.sampling_parameters", "settings.anthropic_version", "request_parameters_sent"):
            self.assertIn(f, fields)
        self.assertTrue(r["headline"].startswith("Model changed, with the following accompanying configuration differences: settings."), r["headline"])
        self.assertIn("request_parameters_sent", r["headline"])
        self.assertTrue(any("no single change (including the model)" in n for n in r["notes"]))
        self.assertIn("Model changed, with the following accompanying configuration differences", out)

    def test_model_change_alone_is_labelled_without_claiming_isolation(self):
        a, b = self.chain("a"), self.chain("b")
        same = dict(settings={"max_tokens": 8192}, request_parameters_sent=[{"max_tokens": 8192}])
        self.relabel(a, "openai", "gpt-5.5-2026-08-01", False, **same)
        self.relabel(b, "openai", "gpt-5.5-2026-10-01", False, **same)
        r = cmp.compare(cmp.load_run(a), cmp.load_run(b))
        self.assertEqual(r["verdict"], cmp.CHANGED)
        self.assertEqual([d["field"] for d in r["differences"]], ["model_requested", "models_served"])
        self.assertIn("No other recorded configuration difference", r["headline"]); self.assertIn("cannot be ruled out", r["headline"])

    def test_fake_vs_real_is_never_a_valid_comparison(self):
        a, b = self.chain("a"), self.chain("b")
        self.relabel(b, "fake", "fake-chain-1", True)          # still fake: consistent
        self.assertEqual(cmp.compare(cmp.load_run(a), cmp.load_run(b))["verdict"], cmp.SAME)
        self.relabel(b, "gemini", "gemini-2.5-pro", False)
        code, out, _ = self.compare(a, b)
        self.assertEqual(code, 5)
        self.assertIn("fake_run", out); self.assertIn("a fake run and a real run are never comparable", out)

    def test_fake_label_inconsistent_with_records_is_refused(self):
        a, b = self.chain("a"), self.chain("b")
        self.edit_summary(b, lambda s: s.update(fake_run=False))   # summary claims real; records are the fake's
        code, _, err = self.compare(a, b)
        self.assertEqual(code, 2); self.assertIn("fake_run=False but the records come from provider(s) ['fake']", err)
        c = self.chain("c")
        self.edit_summary(c, lambda s: s.update(model_requested="gemini-2.5-pro"))
        code, _, err = self.compare(a, c)
        self.assertEqual(code, 2); self.assertIn("model_requested", err)

    def test_missing_settings_is_not_valid(self):
        a, b = self.chain("a"), self.chain("b")
        self.edit_summary(b, lambda s: s.update(settings=None))
        r = cmp.compare(cmp.load_run(a), cmp.load_run(b))
        self.assertEqual(r["verdict"], cmp.INVALID); self.assertIn("settings were not recorded", r["headline"])

    def test_incomplete_run_is_not_comparable(self):
        a, b = self.chain("a"), self.chain("b")
        self.edit_summary(b, lambda s: s.update(incomplete="run stopped after 1 calls: test"))
        code, out, _ = self.compare(a, b)
        self.assertEqual(code, 5); self.assertIn("candidate run is incomplete", out)


class Refusals(NoNetwork):
    def test_tampered_records_are_refused(self):
        a, b = self.chain("a"), self.chain("b")
        with open(os.path.join(b, "records.jsonl"), "a", encoding="utf-8") as f:
            f.write("\n")
        code, out, err = self.compare(a, b)
        self.assertEqual(code, 2); self.assertIn("does not match", err); self.assertEqual(out, "")

    def test_edited_summary_counts_are_refused_even_with_valid_records_hash(self):
        a, b = self.chain("a"), self.chain("b")
        self.edit_summary(b, lambda s: s["counts"]["delegated"]["B"].update(MATCHED=0, OPPOSITE=2))
        code, _, err = self.compare(a, b)
        self.assertEqual(code, 2); self.assertIn("does not match its own records", err)

    def test_summary_file_alone_is_read_but_never_a_valid_comparison(self):
        a, b = self.chain("a"), self.chain("b")
        code, out, _ = self.compare(os.path.join(a, "summary.json"), b)
        self.assertEqual(code, 5); self.assertIn("records verified: NO", out)
        self.assertIn("only a summary was given, so its counts could not be checked", out)

    def test_old_summary_bad_rule_missing_input_and_existing_json_are_refused(self):
        a, b = self.chain("a"), self.chain("b")
        old = self.p("old.json")
        s = json.loads(pathlib.Path(a, "summary.json").read_text())
        for k in ("scenario_sha256", "records_sha256"):
            del s[k]
        pathlib.Path(old).write_text(json.dumps(s))
        existing = self.p("exists.json"); pathlib.Path(existing).write_text("{}")
        for args, msg in (((old, b), "lacks"), ((a, b, "--fail-on-drop", "nonsense:1"), "condition"),
                          ((a, b, "--fail-on-drop", "delegated:C:1"), "direction"), ((a, b, "--fail-on-drop", "delegated:-1"), "whole number"),
                          ((a, self.p("nope")), "does not exist"), ((a, b, "--json", existing), "exists")):
            with self.subTest(msg):
                code, _, err = self.compare(*args)
                self.assertEqual(code, 2); self.assertIn(msg, err)
        self.assertEqual(pathlib.Path(existing).read_text(), "{}")


class Tampering(NoNetwork):
    """The attacks found by the 2026-11-18 agent-based adversarial review (P5): each was accepted before, is refused now."""

    def rewrite(self, d, fn_recs=None, fn_sum=None):
        rp, sp = os.path.join(d, "records.jsonl"), os.path.join(d, "summary.json")
        recs = [json.loads(x) for x in open(rp, encoding="utf-8") if x.strip()]
        if fn_recs:
            recs = fn_recs(recs)
        with open(rp, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(r) + "\n" for r in recs))
        s = json.loads(pathlib.Path(sp).read_text())
        if fn_sum:
            fn_sum(s, recs)
        s["records_sha256"] = ch.file_sha256(rp)
        s.update({k: v for k, v in ch.summarise_chain(recs).items() if k in ("counts", "paired", "calls_recorded")})
        pathlib.Path(sp).write_text(json.dumps(s))

    def refused(self, d, msg):
        with self.assertRaises(cmp.Refused) as cm:
            cmp.load_run(d)
        self.assertIn(msg, str(cm.exception))

    def test_p1_scenario_hash_copied_from_another_scenario(self):
        a = self.chain("a")
        sc2 = dict(json.loads(EXAMPLE.read_text()), context="Volunteers are available on weekdays.")
        p2 = self.p("s2.json"); pathlib.Path(p2).write_text(json.dumps(sc2))
        b = self.chain("b", scenario=p2)
        sha = json.loads(pathlib.Path(a, "summary.json").read_text())["scenario_sha256"]
        self.edit_summary(b, lambda s: s.update(scenario_sha256=sha))
        self.refused(b, "scenario_sha256 does not match the scenario text in the records")
        cmp.load_run(a)   # the genuine run still verifies (the context split is found)

    def test_p2_answer_edited_but_outcome_kept(self):
        b = self.chain("b")
        def edit(recs):
            for r in recs:
                if r["kind"] == "decision" and r["condition"] == "delegated":
                    r["response_text"] = "FIRST CHOICE: %s\nedited" % ("B" if r["parsed"] == "A" else "A"); break
            return recs
        self.rewrite(b, edit)
        self.refused(b, "does not give its recorded outcome when re-read")

    def test_p3_copied_run_is_not_a_repeat(self):
        b = self.chain("b")
        def dup(recs):
            return recs + [dict(r, run=1) for r in recs]
        self.rewrite(b, dup, lambda s, recs: s.update(runs_requested=2, runs=2, planned_calls=136))
        self.refused(b, "call start times go backwards")
        c = self.chain("c")
        self.rewrite(c, lambda recs: recs + [recs[-1]], lambda s, recs: s.update(planned_calls=69))
        self.refused(c, "counts are impossible")   # an extra decision is caught by the summary check first

    def test_retest_copied_run_with_shifted_times_and_response_ids(self):
        """2026-11-18 re-test: copies with forward-shifted times pass the order check; for a real run the provider's
        response ids expose them. (Fake runs are deterministic: a copy is indistinguishable from a rerun.)"""
        b = self.chain("b")
        def realish(recs):
            for n, r in enumerate(recs):
                r.update(provider="gemini", model_requested="g", model_served="g")
                if r.get("t_start") is not None:
                    r["exchange"] = {"request_body": {"x": 1}, "response": {"responseId": "resp-%d" % n}}
            last = recs[-1]["t_start"]
            return recs + [dict(r, run=1, t_start=last[:-6] + "999999" if r.get("t_start") else None) for r in recs]
        self.rewrite(b, realish, lambda s, recs: s.update(provider="gemini", model_requested="g", models_served=["g"], fake_run=False,
                                                          runs_requested=2, runs=2, planned_calls=136))
        self.refused(b, "same provider response id")

    def test_retest_impossible_summary_counts_refused_even_alone(self):
        a = self.chain("a")
        self.edit_summary(a, lambda s: s["counts"]["delegated"]["B"].update(MATCHED=7))
        with self.assertRaises(cmp.Refused) as cm:
            cmp.load_run(os.path.join(a, "summary.json"))
        self.assertIn("counts are impossible", str(cm.exception))

    def test_retest_shared_run_id_with_different_records_is_not_valid(self):
        a, b = self.chain("a"), self.chain("b", "--fake-drift-after", "3")
        rid = json.loads(pathlib.Path(a, "summary.json").read_text())["run_id"]
        self.rewrite(b, lambda recs: [dict(r, run_id=rid) for r in recs], lambda s, recs: s.update(run_id=rid))
        r = cmp.compare(cmp.load_run(a), cmp.load_run(b))
        self.assertEqual(r["verdict"], cmp.INVALID); self.assertIn("same run id but different records", r["headline"])

    def test_p4_summary_only_is_never_valid_and_rules_are_not_evaluated(self):
        a, b = self.chain("a"), self.chain("b")
        self.edit_summary(b, lambda s: s["counts"]["delegated"]["B"].update(MATCHED=0, OPPOSITE=2))
        code, out, _ = self.compare(os.path.join(a, "summary.json"), os.path.join(b, "summary.json"), "--fail-on-drop", "delegated:0")
        self.assertEqual(code, 5); self.assertIn("NOT A VALID CONTROLLED COMPARISON", out)
        self.assertIn("not evaluated", out)

    def test_p5_same_run_on_both_sides_is_not_a_repeatability_check(self):
        a = self.chain("a")
        code, out, _ = self.compare(a, a)
        self.assertEqual(code, 5); self.assertIn("both sides are the same run", out)
        bundle = self.p("a.result.json")
        pathlib.Path(bundle).write_text(json.dumps({"format": "apa-result/1", "saved_note": "t",
                                                    "summary": json.loads(pathlib.Path(a, "summary.json").read_text()),
                                                    "records_jsonl": pathlib.Path(a, "records.jsonl").read_text()}))
        code, out, _ = self.compare(bundle, a)
        self.assertEqual(code, 5); self.assertIn("both sides are the same run", out)

    def test_p9_real_label_without_request_and_response_is_refused(self):
        b = self.chain("b")
        def relabel(recs):
            for r in recs:
                r.update(provider="anthropic", model_requested="claude-x", model_served="claude-x")
            return recs
        self.rewrite(b, relabel, lambda s, recs: s.update(provider="anthropic", model_requested="claude-x", models_served=["claude-x"], fake_run=False))
        self.refused(b, "lacks the exact request and raw response")

    def test_run_ids_are_unique_within_a_second(self):
        a, b = self.chain("a"), self.chain("b")
        ra = json.loads(pathlib.Path(a, "summary.json").read_text())["run_id"]
        rb = json.loads(pathlib.Path(b, "summary.json").read_text())["run_id"]
        self.assertNotEqual(ra, rb); self.assertRegex(ra, r"^\d{8}T\d{6}Z-[0-9a-f]{6}$")

    def test_report_md_matches_the_number_of_runs(self):
        a, b = self.chain("a"), self.chain("b", "--runs", "2")
        self.assertIn("With one run per case", pathlib.Path(a, "report.md").read_text())
        r2 = pathlib.Path(b, "report.md").read_text()
        self.assertNotIn("With one run per case", r2); self.assertIn("2 runs per case", r2)


class DriftingSameSettings(FakeChainProvider):
    """Stands in for a model that changed behind the same id and settings (what a regression check is for): it drifts
    after handoff 3 but reports the default fake settings."""

    def __init__(self, sc):
        super().__init__(sc, drift_after=3, drift_to="A")

    def settings(self):
        return dict(super().settings(), drift_after=None)


class Rules(NoNetwork):
    def run_dir(self, name, prov):
        code, _, _ = ch.execute(SC, prov, self.p(name), 1, ch.ORDERS, fake=True)
        self.assertEqual(code, 0)
        return self.p(name)

    def test_user_rule_tripped_exits_1_and_not_tripped_exits_0(self):
        a = self.run_dir("a", FakeChainProvider(SC))
        b = self.run_dir("b", DriftingSameSettings(SC))
        code, out, _ = self.compare(a, b, "--fail-on-drop", "delegated:1", "--fail-on-drop", "restored:0")
        self.assertEqual(code, 1)
        self.assertIn("VERDICT: SAME CONFIGURATION", out)
        self.assertIn("delegated:1: MATCHED in delegated (both) 4 -> 2, drop 2, allowed 1: TRIPPED", out)
        self.assertIn("restored:0: MATCHED in restored (both) 4 -> 4, drop 0, allowed 0: not tripped", out)
        code, _, _ = self.compare(a, b, "--fail-on-drop", "delegated:2", "--fail-on-drop", "delegated:A:0")
        self.assertEqual(code, 0)
        code, _, _ = self.compare(a, b, "--fail-on-drop", "delegated:B:1")
        self.assertEqual(code, 1)
        code, _, _ = self.compare(a, b)   # no rule of the developer: no failure, whatever the counts
        self.assertEqual(code, 0)

    def test_rules_are_not_evaluated_when_not_valid_but_are_for_a_configuration_change(self):
        a, b = self.chain("a"), self.chain("b", "--orders", "as_given")
        code, out, _ = self.compare(a, b, "--fail-on-drop", "delegated:0")
        self.assertEqual(code, 5); self.assertIn("not evaluated (not a valid controlled comparison)", out)
        c = self.chain("c", "--fake-drift-after", "3")
        code, out, _ = self.compare(a, c, "--fail-on-drop", "delegated:0")
        self.assertEqual(code, 1); self.assertIn("TRIPPED", out)
        code, _, _ = self.compare(a, c, "--fail-on-drop", "delegated:10")
        self.assertEqual(code, 3)

    def test_json_round_trip(self):
        a = self.run_dir("a", FakeChainProvider(SC))
        b = self.run_dir("b", DriftingSameSettings(SC))
        jp = self.p("cmp.json")
        code, out, _ = self.compare(a, b, "--json", jp, "--fail-on-drop", "delegated:0")
        self.assertEqual(code, 1)
        got = json.loads(pathlib.Path(jp).read_text(encoding="utf-8"))
        rules = [cmp.parse_rule("delegated:0")]
        want = json.loads(json.dumps(cmp.compare(cmp.load_run(a), cmp.load_run(b), rules)))
        self.assertEqual(got, want)
        self.assertEqual(got["format"], cmp.COMPARE_FORMAT); self.assertEqual(got["exit_code"], 1)
        self.assertEqual(got["baseline"]["identity"]["scenario_sha256"], ch.scenario_sha256(SC))
        self.assertEqual(len(got["counts"]), len(ch.CONDITIONS) * 2); self.assertEqual(len(got["paired"]), len(ch.CONDITIONS))
        self.assertEqual(cmp.render_text(got), cmp.render_text(want))

    def test_outcome_categories_kept_separate(self):
        class Mixed(FakeChainProvider):
            """Decisions cycle: matched-ish follow, decline (UNCLEAR), malformed (INVALID), failure (MISSING)."""
            n = 0

            def _decide(self, prompt):
                Mixed.n += 1
                k = Mixed.n % 4
                if k == 1:
                    return "FIRST CHOICE: UNCLEAR\nI decline."
                if k == 2:
                    return "**FIRST CHOICE: A**"
                if k == 3:
                    raise ConnectionError("fake failure")
                return super()._decide(prompt)
        a = self.run_dir("a", FakeChainProvider(SC))
        b = self.run_dir("b", Mixed(SC))
        r = cmp.compare(cmp.load_run(a), cmp.load_run(b))
        tot = {o: sum(x["candidate"][o] for x in r["counts"]) for o in ch.OUTCOMES}
        base = {o: sum(x["baseline"][o] for x in r["counts"]) for o in ch.OUTCOMES}
        for o in ("UNCLEAR", "INVALID", "MISSING"):
            self.assertGreater(tot[o], 0, o)
            self.assertEqual(base[o], 0)
        self.assertEqual(sum(tot.values()), 20); self.assertEqual(sum(base.values()), 20)
        # OPPOSITE never absorbs the other categories: its change equals only real opposite choices
        self.assertLessEqual(tot["OPPOSITE"], base["OPPOSITE"])
        for x in r["counts"]:
            self.assertEqual(sum(x["change"].values()), 0)   # same number of decisions per cell, redistributed
            self.assertEqual(set(x["candidate"]), set(ch.OUTCOMES))


if __name__ == "__main__":
    unittest.main()
