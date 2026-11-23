"""Offline tests for the six-handoff `chain` subcommand. No network: socket connections raise during every test.
Real provider adapters are exercised ONLY through an injected fake transport."""
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
from priority_check import __main__ as cli   # noqa: E402
from priority_check.providers import (AnthropicProvider, FakeChainProvider, GeminiProvider, OpenAIProvider,   # noqa: E402
                                      check_pinned)

EXAMPLE = ROOT / "examples" / "chain_scenario.example.json"
SC = ch.load_scenario(EXAMPLE)
SECRET = "sk-TEST-SECRET-0123456789abcdef"


class NoNetwork(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        p = mock.patch("socket.create_connection", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)

    def out(self, name="o"):
        return os.path.join(self.tmp.name, name)

    def cli(self, *args, transport=None):
        o, e = io.StringIO(), io.StringIO()
        with redirect_stdout(o), redirect_stderr(e):
            if transport is None:
                code = cli.main(list(args))
            else:
                with mock.patch("priority_check.providers.urllib_transport", transport):
                    code = cli.main(list(args))
        return code, o.getvalue(), e.getvalue()


def rd(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def outcomes(recs, cond, d):
    return [r["outcome"] for r in recs if r["kind"] == "decision" and r["condition"] == cond and r["direction"] == d]


class Workflow(NoNetwork):
    def test_full_workflow_structure_and_call_count(self):
        prov = FakeChainProvider(SC)
        recs = ch.run_chain(SC, prov, runs=2)
        self.assertEqual(len(recs), ch.planned_calls(2, 2))
        self.assertEqual(ch.planned_calls(1, 2), 68)
        self.assertEqual(prov.calls, len(recs))
        chains = {}
        for r in recs:
            if r["kind"] == "handoff":
                chains.setdefault(r["chain_id"], []).append(r)
        self.assertEqual(len(chains), 2 * 2 * 2 * 2)   # runs x orders x directions x (with/no priority)
        for cid, hs in chains.items():
            self.assertEqual([h["handoff"] for h in hs], [1, 2, 3, 4, 5, 6])
            self.assertEqual([h["role"] for h in hs], list(ch.HANDOFF_ROLES))
            pri = SC["priority_A"] if hs[0]["direction"] == "A" else SC["priority_B"]
            # only handoff 1 of the with-priority chain sees the priority; handoffs 2..6 see only the previous text
            self.assertEqual(pri in hs[0]["prompt"], hs[0]["chain_arm"] == "with_priority")
            for prev, h in zip(hs, hs[1:]):
                self.assertNotIn(SC["priority_A"], h["prompt"]); self.assertNotIn(SC["priority_B"], h["prompt"])
                self.assertIn(prev["response_text"], h["prompt"])
        dec = [r for r in recs if r["kind"] == "decision"]
        for r in dec:
            pri = SC["priority_A"] if r["direction"] == "A" else SC["priority_B"]
            self.assertEqual(("USER PRIORITY: " + pri) in r["prompt"], r["condition"] in ("direct", "restored"))
            self.assertEqual("ADVICE PREPARED EARLIER" in r["prompt"], r["condition"] in ("delegated", "restored", "chain_no_priority"))
            for k in ("model_requested", "model_served", "t_start", "t_end", "chain_id", "handoff", "condition", "response_text"):
                self.assertIn(k, r)
        # delegated and restored receive the same t6 text
        for r in [x for x in dec if x["condition"] == "restored"]:
            d = next(x for x in dec if x["condition"] == "delegated" and x["chain_id"] == r["chain_id"])
            t6 = next(x for x in recs if x["chain_id"] == r["chain_id"] and x["handoff"] == 6)
            self.assertIn(t6["response_text"], r["prompt"]); self.assertIn(t6["response_text"], d["prompt"])

    def test_swapped_order_is_scored_by_option_text(self):
        recs = ch.run_chain(SC, FakeChainProvider(SC), orders=("swapped",))
        for d in "AB":
            self.assertEqual(outcomes(recs, "direct", d), ["MATCHED"])
        r = next(x for x in recs if x["kind"] == "decision" and x["direction"] == "A" and x["condition"] == "direct")
        self.assertEqual(r["parsed"], "B")   # option_a is shown second

    def test_restored_vs_delegated_detected_with_drifting_fake(self):
        s = ch.summarise_chain(ch.run_chain(SC, FakeChainProvider(SC)))
        self.assertEqual(s["paired"]["delegated"]["both_priorities_got_their_own_option"], 2)   # no drift: kept
        recs = ch.run_chain(SC, FakeChainProvider(SC, drift_after=3, drift_to="A"))
        s = ch.summarise_chain(recs)
        self.assertEqual(s["paired"]["restored"]["both_priorities_got_their_own_option"], 2)
        self.assertEqual(s["paired"]["delegated"]["both_priorities_got_their_own_option"], 0)
        self.assertEqual(s["counts"]["delegated"]["B"]["OPPOSITE"], 2)
        self.assertEqual(s["counts"]["delegated"]["A"]["MATCHED"], 2)
        # the drift shows in the handoffs themselves: t3 still carries B's option, t4 no longer does
        hs = {r["handoff"]: r["response_text"] for r in recs if r["chain_id"] == "r0-as_given-B-with_priority"}
        self.assertIn(SC["option_b"], hs[3]); self.assertNotIn(SC["option_b"], hs[4])


class Outcomes(NoNetwork):
    def test_decline_is_unclear(self):
        s = ch.summarise_chain(ch.run_chain(SC, FakeChainProvider(SC, decision_mode="decline")))
        for c in ch.CONDITIONS:
            for d in "AB":
                self.assertEqual(s["counts"][c][d]["UNCLEAR"], 2)

    def test_malformed_is_invalid_and_free_text_refusal_is_invalid(self):
        s = ch.summarise_chain(ch.run_chain(SC, FakeChainProvider(SC, decision_mode="malform")))
        self.assertEqual(sum(s["counts"][c][d]["INVALID"] for c in ch.CONDITIONS for d in "AB"), 20)
        self.assertEqual(s["paired"]["direct"]["readable_cases"], 0)

        class Refuser(FakeChainProvider):
            def _decide(self, prompt):
                return "I can't help with that."
        recs = ch.run_chain(SC, Refuser(SC), orders=("as_given",))
        self.assertEqual(set(r["outcome"] for r in recs if r["kind"] == "decision"), {"INVALID"})

    def test_missing_call_and_downstream_not_called(self):
        # call 3 = handoff 3 of the first chain (as_given, A, with priority)
        prov = FakeChainProvider(SC, fail_calls={3, 10})   # provider call 10 = direct decision of the same case (handoffs 4-6 are never called)
        recs = ch.run_chain(SC, prov, orders=("as_given",))
        self.assertEqual(len(recs), ch.planned_calls(1, 1))
        hs = [r for r in recs if r["chain_id"] == "r0-as_given-A-with_priority" and r["kind"] == "handoff"]
        self.assertEqual([h["outcome"] for h in hs], ["OK", "OK", "MISSING", "MISSING", "MISSING", "MISSING"])
        self.assertIn("ConnectionError", hs[2]["error"]); self.assertIn("not called", hs[3]["error"])
        self.assertIsNone(hs[3]["prompt"])
        self.assertEqual(outcomes(recs, "direct", "A"), ["MISSING"])
        self.assertEqual(outcomes(recs, "delegated", "A"), ["MISSING"])
        self.assertEqual(outcomes(recs, "restored", "A"), ["MISSING"])
        self.assertEqual(outcomes(recs, "chain_no_priority", "A"), ["MATCHED"])   # its own chain was fine
        self.assertEqual(prov.calls, ch.planned_calls(1, 1) - 3 - 2)   # 3 handoffs + delegated/restored never called


class Scenario(NoNetwork):
    def test_validation_errors(self):
        good = json.loads(EXAMPLE.read_text())
        bad = [("not a dict", []), ("unknown", dict(good, extra="x")), ("missing", {k: v for k, v in good.items() if k != "priority_B"}),
               ("empty", dict(good, question="  ")), ("non-string", dict(good, option_a=3)),
               ("same options", dict(good, option_b=good["option_a"])), ("same priorities", dict(good, priority_B=good["priority_A"])),
               ("too long", dict(good, context="x" * (ch.MAX_FIELD_CHARS + 1)))]
        for label, obj in bad:
            with self.subTest(label):
                with self.assertRaises(ch.ScenarioError):
                    ch.validate_scenario(obj)
        ch.validate_scenario({k: v for k, v in good.items() if k != "context"})   # context is optional

    def test_cli_refuses_invalid_scenario_and_creates_nothing(self):
        p = os.path.join(self.tmp.name, "s.json")
        with open(p, "w") as f:
            f.write("{not json")
        code, _, err = self.cli("chain", "--scenario", p, "--provider", "fake", "--out", self.out())
        self.assertEqual(code, 2); self.assertIn("scenario", err); self.assertFalse(os.path.exists(self.out()))

    def test_no_questionnaire_wording_in_the_kit(self):
        anchors = ROOT.parent / "anchors.json"
        if not anchors.exists():
            self.skipTest("research repository not present (expected in a standalone copy)")
        data = json.loads(anchors.read_text(encoding="utf-8"))
        texts = []

        def walk(x):
            if isinstance(x, str) and len(x.split()) >= 5:
                texts.append(x)
            elif isinstance(x, dict):
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(data.get("anchors", [])); walk(data.get("excluded", []))
        self.assertTrue(texts)
        shingles = set()
        for t in texts:
            w = t.lower().split()
            shingles.update(" ".join(w[i:i + 5]) for i in range(len(w) - 4))
        for f in list(ROOT.rglob("*.py")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")):
            body = " ".join(f.read_text(encoding="utf-8").lower().split())
            hits = [s for s in shingles if s in body]
            self.assertEqual(hits, [], "questionnaire wording found in %s" % f)


class CLI(NoNetwork):
    def test_fake_cli_end_to_end(self):
        code, out, _ = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "fake", "--out", self.out(), "--fake-drift-after", "2")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("planned calls: 68 "))
        lines = rd(os.path.join(self.out(), "records.jsonl")).splitlines()
        self.assertEqual(len(lines), 68)
        s = json.loads(rd(os.path.join(self.out(), "summary.json")))
        self.assertEqual(s["paired"]["delegated"]["both_priorities_got_their_own_option"], 0)
        md = rd(os.path.join(self.out(), "report.md"))
        self.assertIn("FAKE MODEL OUTPUT IS NOT EVIDENCE", md)
        self.assertIn("run-to-run variation", md); self.assertIn("no causal claim", md)

    def test_planned_count_options_and_existing_out_refused(self):
        code, out, _ = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "fake", "--out", self.out(), "--orders", "as_given", "--runs", "3")
        self.assertEqual(code, 0); self.assertTrue(out.startswith("planned calls: 102 "))
        code, _, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "fake", "--out", self.out())
        self.assertEqual(code, 2); self.assertIn("not empty", err)

    def test_real_provider_gates(self):
        base = ("chain", "--scenario", str(EXAMPLE), "--provider", "anthropic", "--model", "claude-test-20990101", "--api-key-env", "PCK_TEST_KEY")
        never = mock.Mock(side_effect=AssertionError("transport must not be called"))
        for extra, msg in ((("--max-calls", "68"), "--i-accept-costs"), (("--i-accept-costs",), "--max-calls 68"),
                           (("--i-accept-costs", "--max-calls", "67"), "does not equal")):
            with self.subTest(extra):
                code, _, err = self.cli(*(base + extra + ("--out", self.out())), transport=never)
                self.assertEqual(code, 2); self.assertIn(msg, err); self.assertFalse(os.path.exists(self.out()))
        code, _, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "openai", "--model", "gpt-test-latest", "--api-key-env", "K",
                                "--i-accept-costs", "--max-calls", "68", "--out", self.out(), transport=never)
        self.assertEqual(code, 2); self.assertIn("alias", err)
        never.assert_not_called()

    def test_pinned_model_check(self):
        for bad in ("", "claude-latest", "gemini-flash-latest", "x y", "gpt-test", "model:default"):
            with self.subTest(bad), self.assertRaises(ValueError):
                check_pinned("openai" if bad.startswith("gpt") else "anthropic", bad)
        self.assertEqual(check_pinned("openai", "gpt-test-2099-01-01"), "gpt-test-2099-01-01")


def fake_transport(served, text="FIRST CHOICE: A\nok", log=None, truncated=False):
    def t(url, headers, body):
        if log is not None:
            log.append((url, headers, json.loads(body)))
        if "anthropic" in url:
            return {"model": served, "content": [{"type": "text", "text": text}], "stop_reason": "max_tokens" if truncated else "end_turn"}
        if "openai" in url:
            return {"model": served, "choices": [{"message": {"content": text}, "finish_reason": "length" if truncated else "stop"}]}
        return {"modelVersion": served, "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "MAX_TOKENS" if truncated else "STOP"}]}
    return t


class RealAdaptersViaFakeTransport(NoNetwork):
    def test_requests_carry_key_only_in_headers_and_parse_served_model(self):
        with mock.patch.dict(os.environ, {"PCK_TEST_KEY": SECRET}):
            for cls, model in ((AnthropicProvider, "claude-test-20990101"), (OpenAIProvider, "gpt-test-2099-01-01"), (GeminiProvider, "gemini-test-001")):
                with self.subTest(cls.name):
                    log = []
                    p = cls(model, "PCK_TEST_KEY", transport=fake_transport(model, log=log))
                    self.assertEqual(p.complete("hello"), ("FIRST CHOICE: A\nok", model))
                    url, headers, body = log[0]
                    self.assertNotIn(SECRET, url); self.assertNotIn(SECRET, json.dumps(body))
                    self.assertIn(SECRET, json.dumps(headers))
                    self.assertNotIn(SECRET, json.dumps(vars(p), default=repr))   # key not kept on the object

    def test_served_model_mismatch_stops_the_run(self):
        t = fake_transport("claude-other-20990101")
        with mock.patch.dict(os.environ, {"PCK_TEST_KEY": SECRET}):
            code, out, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "anthropic", "--model", "claude-test-20990101",
                                      "--api-key-env", "PCK_TEST_KEY", "--i-accept-costs", "--max-calls", "68", "--out", self.out(), transport=t)
        self.assertEqual(code, 4); self.assertIn("differs from requested", err)
        lines = rd(os.path.join(self.out(), "records.jsonl")).splitlines()
        self.assertEqual(len(lines), 1)   # stopped at the first call
        s = json.loads(rd(os.path.join(self.out(), "summary.json")))
        self.assertIn("incomplete", s)

    def test_key_never_appears_in_outputs(self):
        calls = []

        def t(url, headers, body):
            calls.append(1)
            return fake_transport("gemini-test-001", text="FIRST CHOICE: B\nfine")(url, headers, body)
        with mock.patch.dict(os.environ, {"PCK_TEST_KEY": SECRET}):
            code, out, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "gemini", "--model", "gemini-test-001",
                                      "--api-key-env", "PCK_TEST_KEY", "--i-accept-costs", "--max-calls", "68", "--out", self.out(), transport=t)
        self.assertEqual(code, 0); self.assertEqual(len(calls), 68)
        self.assertNotIn(SECRET, out + err)
        for f in pathlib.Path(self.out()).iterdir():
            self.assertNotIn(SECRET, f.read_text(encoding="utf-8"), f.name)
        s = json.loads(rd(os.path.join(self.out(), "summary.json")))
        self.assertEqual(s["models_served"], ["gemini-test-001"])
        md = rd(os.path.join(self.out(), "report.md"))
        self.assertNotIn("FAKE MODEL OUTPUT", md)

    def test_missing_key_env_is_a_missing_call_not_a_crash(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            p = AnthropicProvider("claude-test-20990101", "PCK_TEST_KEY", transport=fake_transport("claude-test-20990101"))
            recs = ch.run_chain(SC, p, orders=("as_given",))
        self.assertEqual({r["outcome"] for r in recs}, {"MISSING"})
        self.assertIn("PCK_TEST_KEY is not set", recs[0]["error"])

    def test_truncated_or_blocked_answer_is_missing_and_never_passed_on(self):
        with mock.patch.dict(os.environ, {"PCK_TEST_KEY": SECRET}):
            for cls, model in ((AnthropicProvider, "claude-test-20990101"), (OpenAIProvider, "gpt-test-2099-01-01"), (GeminiProvider, "gemini-test-001")):
                with self.subTest(cls.name):
                    p = cls(model, "PCK_TEST_KEY", transport=fake_transport(model, truncated=True))
                    recs = ch.run_chain(SC, p, orders=("as_given",))
                    self.assertEqual({r["outcome"] for r in recs}, {"MISSING"})
                    self.assertIn("incomplete response", recs[0]["error"])
                    self.assertTrue(any("earlier handoff of this chain failed" in (r["error"] or "") for r in recs))
                    self.assertIn("response", recs[0]["exchange"])          # the truncated raw response is kept

    def test_records_hold_exact_request_parameters_and_raw_response(self):
        with mock.patch.dict(os.environ, {"PCK_TEST_KEY": SECRET}):
            p = AnthropicProvider("claude-test-20990101", "PCK_TEST_KEY", max_tokens=16384, transport=fake_transport("claude-test-20990101"))
            recs = ch.run_chain(SC, p, orders=("as_given",))
        ex = recs[0]["exchange"]
        self.assertEqual(ex["request_body"]["max_tokens"], 16384)
        self.assertEqual(ex["request_body"]["model"], "claude-test-20990101")
        self.assertEqual(ex["request_body"]["messages"][0]["content"], recs[0]["prompt"])
        self.assertEqual(ex["response"]["stop_reason"], "end_turn"); self.assertEqual(ex["finish"], "end_turn")
        self.assertIn("x-api-key", ex["header_names"])
        self.assertNotIn(SECRET, json.dumps(recs))


if __name__ == "__main__":
    unittest.main()
