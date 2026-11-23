"""Tests for the LangGraph example (examples/langgraph_workflow). Skipped unless LangGraph is installed (pinned in
examples/langgraph_workflow/requirements.lock). Offline: the example's fake model only; no network."""
import json
import pathlib
import socket
import sys
import tempfile
import unittest
import warnings
from unittest import mock

warnings.filterwarnings("ignore")
ROOT = pathlib.Path(__file__).resolve().parents[1]
EX = ROOT / "examples" / "langgraph_workflow"
sys.path[:0] = [str(ROOT), str(EX)]
try:
    import langgraph  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False
from priority_check import chain as ch, compare as cmp, workflow as WF   # noqa: E402


@unittest.skipUnless(HAVE, "LangGraph is not installed")
class LangGraphExample(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        import adapter as AD
        self.AD = AD
        AD._SHARED["saver"] = None
        self.sc = ch.load_scenario(EX / "laptop.scenario.json")

    def run_(self, name, cfg, runs=1):
        code, _, s = WF.execute(self.sc, self.AD.ShopAdvisorAdapter(), pathlib.Path(self.tmp.name, name), runs, ch.ORDERS, config=cfg)
        recs = [json.loads(x) for x in open(pathlib.Path(self.tmp.name, name, "records.jsonl"))]
        return code, s, recs

    def decider_exposure(self, recs):
        out = set()
        for r in recs:
            if r["kind"] == "execution" and r["condition"] == "workflow":
                out |= {x["where"] for x in r["exposure"]["given_priority_found"] if x["agent"] == "decider"}
        return out

    def test_real_framework_routing_and_trace(self):
        code, s, recs = self.run_("a", {})
        self.assertEqual(code, 0); self.assertEqual(s["executions"], 14); self.assertEqual(s["not_supported"], [])
        e = next(r for r in recs if r["kind"] == "execution" and r["condition"] == "workflow")
        self.assertEqual(sorted(a["id"] for a in e["trace"]["agents"]), ["care_specialist", "coordinator", "cost_specialist", "decider"])
        self.assertTrue(s["fake_run"])

    def test_regression_unintended_priority_access_through_shared_state(self):
        """The shipped graph copies the profile (the priority) from shared state into the decider's model request; the
        fixed graph leaves it in state only. The exposure check must tell these apart."""
        self.assertEqual(self.decider_exposure(self.run_("shipped", {})[2]), {"model request"})
        self.assertEqual(self.decider_exposure(self.run_("fixed", {"personalize_decider": False})[2]), {"visible state only"})

    def test_state_carryover_between_executions_is_detected(self):
        code, s, recs = self.run_("mem", {"share_memory": True})
        self.assertGreater(s["exposure_checks"]["no_priority_executions_with_priority_text"], 0)
        self.AD._SHARED["saver"] = None
        self.assertEqual(self.run_("clean", {})[1]["exposure_checks"]["no_priority_executions_with_priority_text"], 0)

    def test_fix_is_a_listed_configuration_change(self):
        self.run_("a", {}, runs=2); self.run_("b", {"personalize_decider": False}, runs=2)
        r = cmp.compare(cmp.load_run(pathlib.Path(self.tmp.name, "a")), cmp.load_run(pathlib.Path(self.tmp.name, "b")))
        self.assertEqual(r["verdict"], cmp.CHANGED); self.assertEqual([d["field"] for d in r["differences"]], ["config.personalize_decider"])

    def budget(self, **kw):
        b = {"path": str(pathlib.Path(self.tmp.name, "ledger.jsonl")), "max_calls": 1000, "max_cost_usd": 100.0,
             "input_usd_per_1m": 0.75, "output_usd_per_1m": 3.75, "max_output_tokens": 16384}
        b.update(kw)
        return b

    def ledger(self):
        p = pathlib.Path(self.tmp.name, "ledger.jsonl")
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def test_budget_records_every_internal_call_with_usage_and_cost(self):
        code, s, recs = self.run_(("b1"), {"budget": self.budget()})
        L = self.ledger()
        self.assertEqual(code, 0)
        # per run and order: 3 workflow executions x 4 agents + 4 single-call probes = 16; x 2 orders
        self.assertEqual(len(L), 32)
        self.assertEqual(sorted({e["agent"] for e in L}), ["care_specialist", "coordinator", "cost_specialist", "decider"])
        self.assertTrue(all(e["status"] == "ok" and e["charged_usd"] > 0 and e["reserved_usd"] >= e["charged_usd"] for e in L))
        e = next(r for r in recs if r["kind"] == "execution" and r["condition"] == "workflow")
        self.assertTrue(all(a["usage"]["usage_source"] == "estimate" for a in e["trace"]["agents"]))   # the fake reports no usage

    def test_call_cap_stops_the_run_before_the_next_call(self):
        code, s, recs = self.run_("b2", {"budget": self.budget(max_calls=10)})
        self.assertEqual(code, 4); self.assertIn("call cap reached: 10 of 10", s["incomplete"])
        self.assertEqual(len(self.ledger()), 10)

    def test_dollar_cap_uses_the_worst_case_reservation(self):
        # one attempt may cost up to ~$0.0615 (16,384 output tokens at $3.75/M); with a $0.066 cap the run must stop
        # once actual charges leave less headroom than one worst case, and never exceed the cap
        b = self.budget(max_cost_usd=0.066)
        code, s, recs = self.run_("b3", {"budget": b})
        L = self.ledger()
        self.assertEqual(code, 4); self.assertIn("dollar cap", s["incomplete"])
        self.assertGreater(len(L), 0); self.assertLess(len(L), 32)
        before = 0.0
        for e in L:     # every attempt was admitted only if what was already charged plus its worst case fit the cap
            self.assertLessEqual(before + e["reserved_usd"], 0.066 + 1e-12)
            before += e["charged_usd"]
        self.assertLessEqual(before, 0.066)
        worst_out = 16384 * 3.75 / 1e6
        self.assertTrue(all(e["reserved_usd"] >= worst_out for e in L))

    def test_cap_is_cumulative_across_runs(self):
        self.run_("c1", {"budget": self.budget(max_calls=40)})
        self.AD._SHARED["saver"] = None
        code, s, recs = self.run_("c2", {"budget": self.budget(max_calls=40)})
        self.assertEqual(code, 4); self.assertEqual(len(self.ledger()), 40)

    def test_retries_count_against_the_cap_and_are_recorded(self):
        import shop_graph as SG
        orig = SG.FakeChatModel.invoke
        state = {"n": 0}
        def flaky(self_, messages):
            state["n"] += 1
            if state["n"] == 3:
                raise TimeoutError("simulated")
            return orig(self_, messages)
        with mock.patch.object(SG.FakeChatModel, "invoke", flaky):
            code, s, recs = self.run_("r1", {"budget": self.budget()})
        L = self.ledger()
        self.assertEqual(code, 0)
        bad = [e for e in L if e["status"].startswith("transient")]
        self.assertEqual(len(bad), 1); self.assertEqual(bad[0]["charged_usd"], bad[0]["reserved_usd"])   # unknown billing: worst case
        self.assertEqual(len(L), 33)                                                                      # 32 + 1 retry

    def test_provider_usage_is_charged_when_reported(self):
        import shop_graph as SG
        orig = SG.FakeChatModel.invoke
        def with_usage(self_, messages):
            out = orig(self_, messages)
            self_.last_usage = {"input_tokens": 1000, "output_tokens": 500}
            return out
        with mock.patch.object(SG.FakeChatModel, "invoke", with_usage):
            self.run_("u1", {"budget": self.budget()})
        L = self.ledger()
        self.assertTrue(all(e["usage_source"] == "provider" and abs(e["charged_usd"] - (1000 * 0.75 + 500 * 3.75) / 1e6) < 1e-9 for e in L))

    def test_portability_check_against_the_kit_reference_chain(self):
        import reference_chain_graph as RC
        r = RC.check(ch.load_scenario(ROOT / "examples" / "chain_scenario.example.json"))
        self.assertEqual((r["calls_kit"], r["calls_langgraph"], r["identical_request_text"]), (68, 68, 68))
        self.assertTrue(r["handoff_boundaries_identical"])


if __name__ == "__main__":
    unittest.main()
