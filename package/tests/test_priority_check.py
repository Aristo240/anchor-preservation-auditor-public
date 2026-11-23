"""Offline tests for priority_check (standard-library unittest; also collected by pytest). No network: any socket
connection raises during the tests."""
import io
import json
import pathlib
import socket
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from priority_check import Decision, build_prompt, parse_strict, parse_tolerant, run, summarise, variants, write_outputs   # noqa: E402
from priority_check.fake import FakeFinalStep, FakeWorkflow   # noqa: E402
from priority_check import __main__ as cli   # noqa: E402

SPEC = json.loads((ROOT / "examples" / "decision_example.json").read_text())
RULES = SPEC.pop("_fake_rules")
D = Decision(**SPEC)


class NoNetwork(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)


class Prompts(NoNetwork):
    def test_pair_differs_only_by_the_priority_line(self):
        a = build_prompt(D.task, D.option_a, D.option_b, D.step_input, None)
        b = build_prompt(D.task, D.option_a, D.option_b, D.step_input, D.priority)
        self.assertEqual(b.replace("USER PRIORITY: %s\n" % D.priority, ""), a)

    def test_matches_the_study_prompt_when_the_repository_is_available(self):
        s3 = ROOT.parent / "Cosmos_Delegation_Study3"
        if not (s3 / "protocol3.py").exists():
            self.skipTest("study repository not present (expected in a standalone copy)")
        sys.path.insert(0, str(s3))
        import protocol3
        case = {"task": D.task, "options": {"A": D.option_a, "B": D.option_b}, "user_priority": D.priority}
        self.assertEqual(build_prompt(D.task, D.option_a, D.option_b, D.step_input, D.priority), protocol3.decision_prompt(case, "restored", D.step_input))
        self.assertEqual(build_prompt(D.task, D.option_a, D.option_b, D.step_input, None), protocol3.decision_prompt(case, "delegated", D.step_input))


class Parsing(NoNetwork):
    def test_strict(self):
        self.assertEqual(parse_strict("FIRST CHOICE: B\nwhy"), "B")
        self.assertEqual(parse_strict("first choice: unclear"), "UNCLEAR")
        for bad in ("**FIRST CHOICE: B**", "Sure! FIRST CHOICE: A", "", None, "FIRST CHOICE: C"):
            self.assertEqual(parse_strict(bad), "INVALID")

    def test_tolerant_is_separate(self):
        self.assertEqual(parse_tolerant("**FIRST CHOICE: B**"), "B")
        self.assertEqual(parse_strict("**FIRST CHOICE: B**"), "INVALID")


class Design(NoNetwork):
    def test_variants_and_validation(self):
        self.assertEqual(len(variants(D)), 8)
        self.assertEqual(len(variants(D, reverse=False, swap=False)), 2)
        with self.assertRaises(ValueError):
            Decision("x", "t", "a", "b", "p", favors="C")
        with self.assertRaises(ValueError):
            Decision("x", "t", "a", "b", "p", favors="A", reversed_priority="q")
        with self.assertRaises(ValueError):
            Decision("x", "t", "same", "same", "p", favors="A")


class Runs(NoNetwork):
    def test_follow_with_reminder_ignore_without(self):
        recs = run(D, FakeFinalStep(rules=RULES, default="A"), repeats=3)
        self.assertEqual(len(recs), 24)
        s = summarise(recs)
        self.assertEqual(s["attempts"], 24)
        for k in ("original|as_given", "original|swapped", "reversed|as_given", "reversed|swapped"):
            self.assertEqual(s["reminder_pairs"][k]["readable_pairs"], 3)
            self.assertEqual(s["reminder_pairs"][k]["matched_with_reminder"], 3)
        # without the line the fake always answers letter A: matches only where A holds the favoured option
        self.assertEqual(s["by_variant"]["original|no_reminder|as_given"]["matched"], 3)
        self.assertEqual(s["by_variant"]["original|no_reminder|swapped"]["opposite"], 3)
        self.assertEqual(s["reversal"]["reminder|as_given"]["both_followed_their_priority"], 3)
        self.assertEqual(s["reversal"]["no_reminder|as_given"]["both_followed_their_priority"], 0)
        self.assertEqual(s["letter_position"]["swapped"]["A"] >= 6, True)   # a letter preference shows up across orders

    def test_swap_matches_by_option_text(self):
        recs = run(D, FakeFinalStep(rules=RULES), repeats=1)
        r = next(x for x in recs if x["order"] == "swapped" and x["reminder"] and x["priority"] == "original")
        self.assertEqual(r["option_a_shown"], D.option_b)
        self.assertEqual(r["chosen_option_text"], D.option_a)
        self.assertEqual(r["outcome"], "matched")

    def test_invalid_and_errors_are_counted_not_dropped(self):
        recs = run(D, FakeFinalStep(rules=RULES, noise=0.5), repeats=6, reverse=False, swap=False)
        s = summarise(recs)
        inv = sum(c["invalid"] for c in s["by_variant"].values())
        self.assertGreater(inv, 0)
        p = s["reminder_pairs"]["original|as_given"]
        self.assertEqual(p["attempted_pairs"], 6)
        self.assertEqual(p["readable_pairs"] + p["unreadable_or_error_pairs"], 6)
        self.assertGreater(s["tolerant_parser_sensitivity"]["answers_read_differently"], 0)

        calls = {"n": 0}

        def flaky(prompt):
            calls["n"] += 1
            if calls["n"] % 2:
                raise TimeoutError("upstream timeout")
            return "FIRST CHOICE: A"
        recs2 = run(D, flaky, repeats=2, reverse=False, swap=False)
        self.assertEqual(sum(1 for r in recs2 if r["outcome"] == "error"), 2)
        self.assertTrue(all("TimeoutError" in r["error"] for r in recs2 if r["outcome"] == "error"))

    def test_workflow_adapter(self):
        recs = run(D, FakeWorkflow(rules=RULES), repeats=2)
        s = summarise(recs)
        self.assertEqual(s["by_variant"]["original|no_reminder|as_given"]["unclear"], 2)
        self.assertEqual(s["by_variant"]["original|reminder|as_given"]["matched"], 2)
        self.assertTrue(all(r["prompt"] is None and "workflow adapter" in r["prompt_note"] for r in recs))

    def test_records_are_inspectable_and_machine_readable(self):
        recs = run(D, FakeFinalStep(rules=RULES), repeats=2)
        with tempfile.TemporaryDirectory() as t:
            paths = write_outputs(recs, summarise(recs), t)
            lines = pathlib.Path(paths["records"]).read_text().splitlines()
            self.assertEqual(len(lines), len(recs))
            r0 = json.loads(lines[0])
            for k in ("prompt", "prompt_sha256", "response_raw", "strict", "tolerant", "outcome", "variant", "repeat", "target_option_text"):
                self.assertIn(k, r0)
            self.assertIn("not the six-handoff delegation evaluation", pathlib.Path(paths["markdown"]).read_text())
            json.loads(pathlib.Path(paths["summary"]).read_text())

    def test_cli_with_fake(self):
        with tempfile.TemporaryDirectory() as t:
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cli.main(["run", "--spec", str(ROOT / "examples" / "decision_example.json"), "--fake", "--repeats", "2", "--out", t])
            self.assertEqual(rc, 0)
            self.assertTrue((pathlib.Path(t) / "records.jsonl").exists())


class Repairs(NoNetwork):
    """K1-K6 (each of these failed on the r6 kit)."""
    SPECF = str(ROOT / "examples" / "decision_example.json")

    def test_k1_non_text_answers_are_recorded_and_never_break_writing(self):
        answers = iter([b"FIRST CHOICE: A", {"choice": "A"}, None, 42])
        recs = run(D, lambda prompt: next(answers), repeats=2, reverse=False, swap=False)
        self.assertEqual(len(recs), 4)
        self.assertTrue(all(r["outcome"] == "invalid" and r["response_raw"] is None for r in recs))
        self.assertEqual([r["response_nontext"]["type"] for r in recs], ["bytes", "dict", "NoneType", "int"])
        with tempfile.TemporaryDirectory() as t:
            paths = write_outputs(recs, summarise(recs), pathlib.Path(t) / "out")
            self.assertEqual(len(pathlib.Path(paths["records"]).read_text().splitlines()), 4)

    def test_k2_finished_records_survive_an_interruption(self):
        calls = {"n": 0}

        def step(prompt):
            calls["n"] += 1
            if calls["n"] == 4:
                raise KeyboardInterrupt
            return "FIRST CHOICE: A"
        with tempfile.TemporaryDirectory() as t, mock.patch.object(cli, "load_adapter", return_value=step):
            out = pathlib.Path(t) / "out"
            with redirect_stdout(io.StringIO()):
                rc = cli.main(["run", "--spec", self.SPECF, "--adapter", "x:y", "--repeats", "2", "--out", str(out)])
            self.assertEqual(rc, 130)
            self.assertEqual(len((out / "records.jsonl").read_text().splitlines()), 3)
            s = json.loads((out / "summary.json").read_text())
            self.assertEqual(s["attempts"], 3)
            self.assertIn("interrupted after 3", s["incomplete"])
            self.assertIn("INCOMPLETE RUN", (out / "summary.md").read_text())

    def test_k2_records_are_on_disk_before_the_run_ends(self):
        with tempfile.TemporaryDirectory() as t:
            from priority_check import RecordWriter, prepare_out_dir
            w = RecordWriter(prepare_out_dir(pathlib.Path(t) / "o")); seen = []

            def step(prompt):
                seen.append(len(w.path.read_text().splitlines()))
                return "FIRST CHOICE: A"
            run(D, step, repeats=3, reverse=False, swap=False, sink=w.write); w.close()
            self.assertEqual(seen, [0, 1, 2, 3, 4, 5])

    def test_k3_existing_results_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as t:
            out = pathlib.Path(t) / "out"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["run", "--spec", self.SPECF, "--fake", "--repeats", "1", "--out", str(out)]), 0)
            before = {p.name: p.read_bytes() for p in out.iterdir()}
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), mock.patch("sys.stderr", err):
                self.assertEqual(cli.main(["run", "--spec", self.SPECF, "--fake", "--repeats", "2", "--out", str(out)]), 2)
            self.assertIn("not empty", err.getvalue())
            self.assertEqual({p.name: p.read_bytes() for p in out.iterdir()}, before)
            recs = run(D, FakeFinalStep(rules=RULES), repeats=1)
            with self.assertRaises(FileExistsError):
                write_outputs(recs, summarise(recs), out)

    def test_k4_pairs_never_cross_runs_or_decisions(self):
        follow = run(D, FakeFinalStep(rules=RULES, default="B"), repeats=2, reverse=False, swap=False, run_id="r1")
        ignore = run(D, lambda p: "FIRST CHOICE: A", repeats=2, reverse=False, swap=False, run_id="r2")
        s = summarise(follow + ignore)
        p = s["reminder_pairs"]["original|as_given"]
        self.assertEqual(s["runs_and_decisions"], 2)
        self.assertEqual(p["attempted_pairs"], 4)
        self.assertEqual(p["choice_changed"], 2)          # only r1 changes (B -> A); r2 never changes
        d2 = Decision(**dict(SPEC, decision_id="other"))
        s2 = summarise(run(D, lambda p: "FIRST CHOICE: A", repeats=1, reverse=False, swap=False, run_id="r")
                       + run(d2, lambda p: "FIRST CHOICE: B", repeats=1, reverse=False, swap=False, run_id="r"))
        self.assertEqual(s2["reminder_pairs"]["original|as_given"]["choice_changed"], 0)
        with self.assertRaises(ValueError):
            summarise(follow + follow)

    def test_k5_workflow_adapters_get_no_fake_prompt_hash(self):
        recs = run(D, FakeWorkflow(rules=RULES), repeats=1)
        self.assertTrue(all(r["prompt_sha256"] is None and r["prompt"] is None for r in recs))
        self.assertTrue(all(len(r["inputs_sha256"]) == 64 for r in recs))
        on = [r for r in recs if r["reminder"]]; off = [r for r in recs if not r["reminder"]]
        self.assertNotEqual(on[0]["inputs_sha256"], off[0]["inputs_sha256"])
        pr = run(D, FakeFinalStep(rules=RULES), repeats=1)
        import hashlib
        self.assertTrue(all(r["prompt_sha256"] == hashlib.sha256(r["prompt"].encode()).hexdigest() for r in pr))

    def test_k6_packaging_docs_and_adapter_loading(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("_fake_rules", readme)
        self.assertNotIn("zero-argument factory", (ROOT / "priority_check" / "__main__.py").read_text())
        py = (ROOT / "pyproject.toml").read_text()
        self.assertIn('name = "priority-check"', py)
        self.assertIn("requires-python", py)
        mod = type(sys)("k6_adapters")
        mod.prompt_fn = lambda p: "FIRST CHOICE: A"

        class WF:
            def decide(self, *a):
                return "FIRST CHOICE: A"
        mod.WF = WF; mod.notadapter = 5
        with mock.patch.dict(sys.modules, {"k6_adapters": mod}):
            self.assertIs(cli.load_adapter("k6_adapters:prompt_fn"), mod.prompt_fn)
            self.assertTrue(hasattr(cli.load_adapter("k6_adapters:WF"), "decide"))
            with self.assertRaises(SystemExit):
                cli.load_adapter("k6_adapters:notadapter")


class ReviewFixes(NoNetwork):
    """Independent review of the v4 kit (release/independent_review_v4/A5): each of these failed before the fix."""
    SPECF = str(ROOT / "examples" / "decision_example.json")

    def cli(self, argv, step):
        err = io.StringIO()
        with mock.patch.object(cli, "load_adapter", return_value=step), redirect_stdout(io.StringIO()), mock.patch("sys.stderr", err):
            return cli.main(argv), err.getvalue()

    def test_a7_noise_level_and_arm_rates_reported(self):
        # a step that ignores the priority and answers at random: "differed" is non-zero, but the noise row shows
        # repeats of the SAME prompt differ just as often, and the arm rates are equal in expectation
        import random
        rng = random.Random(7)
        recs = run(D, lambda p: "FIRST CHOICE: " + rng.choice("AB"), repeats=10, reverse=False, swap=False, run_id="r")
        s = summarise(recs)
        self.assertGreater(s["reminder_pairs"]["original|as_given"]["choice_changed"], 0)
        v = s["within_arm_variation"]
        self.assertEqual(v["no_reminder"]["repeat_pairs"], 45); self.assertGreater(v["no_reminder"]["repeat_pairs_differing"], 0)
        self.assertEqual(s["matched_rate_by_arm"]["reminder"]["readable_attempts"], 10)
        md = summarise.__globals__["render_md"](s)
        self.assertIn("differed (includes run-to-run variation)", md); self.assertNotIn("| changed |", md)
        self.assertLess(md.index("Matched rate in each arm"), md.index("Outcomes by variant"))
        self.assertIn("share differing", md); self.assertIn("share differed", md)   # comparable as shares, not raw counts
        # a deterministic step: no within-arm variation
        s2 = summarise(run(D, FakeFinalStep(rules=RULES, default="B"), repeats=3, reverse=False, swap=False))
        self.assertEqual(s2["within_arm_variation"]["reminder"]["repeat_pairs_differing"], 0)
        self.assertEqual(s2["matched_rate_by_arm"]["reminder"]["matched"], 3)

    def test_p1_1_text_that_is_not_valid_unicode_is_kept_not_fatal(self):
        bad = "FIRST CHOICE: A\nthen a broken character \ud800 at the end"
        with tempfile.TemporaryDirectory() as t:
            out = pathlib.Path(t) / "out"
            rc, _ = self.cli(["run", "--spec", self.SPECF, "--adapter", "x:y", "--repeats", "1", "--out", str(out)], lambda p: bad)
            self.assertEqual(rc, 0)
            lines = (out / "records.jsonl").read_text().splitlines()
            self.assertEqual(len(lines), 8)
            self.assertEqual(json.loads(lines[0])["response_raw"], bad)          # lossless round trip
            self.assertTrue((out / "summary.md").exists())
        d = Decision(**dict(SPEC, step_input="input with \udc80 in it"))
        self.assertEqual(len(run(d, lambda p: "FIRST CHOICE: A", repeats=1)), 8)      # hashing does not crash either
        recs = run(d, FakeFinalStep(rules=RULES), repeats=1)                     # nor does the built-in fake
        self.assertFalse([r for r in recs if r["outcome"] == "error"], [r.get("error") for r in recs][:1])

    def test_p1_2_no_readable_pair_is_a_failure_exit(self):
        def broken(prompt):
            raise NotImplementedError("adapter not written yet")
        with tempfile.TemporaryDirectory() as t:
            rc, err = self.cli(["run", "--spec", self.SPECF, "--adapter", "x:y", "--repeats", "1", "--out", str(pathlib.Path(t) / "o")], broken)
            self.assertEqual(rc, 3)
            self.assertIn("8 of 8 calls gave an error", err)
            self.assertIn("no with/without pair was readable", err)

    def test_p1_2_some_bad_answers_warn_but_succeed(self):
        answers = iter(["nonsense"] + ["FIRST CHOICE: A"] * 7)
        with tempfile.TemporaryDirectory() as t:
            rc, err = self.cli(["run", "--spec", self.SPECF, "--adapter", "x:y", "--repeats", "1", "--out", str(pathlib.Path(t) / "o")],
                               lambda p: next(answers))
            self.assertEqual(rc, 0)
            self.assertIn("warning: 1 of 8", err)

    def test_p2_2_zero_repeats_refused_before_anything_is_created(self):
        with tempfile.TemporaryDirectory() as t:
            out = pathlib.Path(t) / "o"
            with self.assertRaises(SystemExit), mock.patch("sys.stderr", io.StringIO()):
                cli.main(["run", "--spec", self.SPECF, "--fake", "--repeats", "0", "--out", str(out)])
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
