"""Offline tests for `priority_check workflow` (whole-workflow adapter). A standard-library fake multi-agent adapter is
used; the LangGraph example has its own test (test_langgraph_example.py, skipped without LangGraph). No network."""
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
from priority_check import chain as ch, compare as cmp, workflow as WF   # noqa: E402
from priority_check import __main__ as cli                                # noqa: E402

SC = ch.load_scenario(ROOT / "examples" / "chain_scenario.example.json")
FAV = {SC["priority_A"]: SC["option_a"], SC["priority_B"]: SC["option_b"]}


class ToyWorkflow:
    """planner -> decider. The planner sees the priority; the decider sees the planner's note (and, if leak=True, the
    priority too). memory=True keeps state between requests (a deliberate carryover bug)."""
    MEMORY = {}

    def __init__(self, leak=False, memory=False, direct=True, restored=True, fake=True, served=None, final=None):
        self.leak, self.memory, self.sup, self.fake, self.served, self.final = leak, memory, {"direct": direct, "restored": restored}, fake, served, final
        self.calls = []

    def describe(self):
        return {"name": "toy", "version": "1", "fake": self.fake, "provider": "toy", "models": ["toy-1"], "settings": {"leak": self.leak},
                "agents": [{"id": "planner", "role": "planner"}, {"id": "decider", "role": "final decision"}],
                "priority_entry": "planner prompt", "supports": dict(self.sup)}

    def _decide(self, a, b, text):
        pri = next((p for p in FAV if p in text), None)
        if pri:
            return "FIRST CHOICE: %s" % ("A" if FAV[pri] == a else "B")
        return "FIRST CHOICE: UNCLEAR"

    def run(self, request):
        self.calls.append(request["execution_id"])
        state = ToyWorkflow.MEMORY if self.memory else {}
        if request["priority"]:
            state["priority"] = request["priority"]
        pri = state.get("priority")
        p_req = "Plan for: %s\n%s" % (request["task"], ("Priority: %s" % pri) if pri else "")
        note = "NOTE: weigh both options carefully for the household"
        d_req = "Decide between A: %s and B: %s.\n%s\n%s" % (request["option_a"], request["option_b"], note, ("Priority: %s" % pri) if (self.leak and pri) else "")
        out = self.final or self._decide(request["option_a"], request["option_b"], d_req)
        agents = [{"id": "planner", "role": "planner", "model": "toy-1", "request_messages": [{"role": "user", "content": p_req}], "request_complete": True,
                   "state_visible": dict(state), "state_complete": True, "output": note},
                  {"id": "decider", "role": "final decision", "model": "toy-1", "request_messages": [{"role": "user", "content": d_req}], "request_complete": True,
                   "state_visible": dict(state), "state_complete": True, "output": out}]
        return {"final_text": out, "decision_input": note, "trace": {"format": WF.TRACE_FORMAT, "agents": agents},
                "models_served": self.served or ["toy-1"]}

    def decide_direct(self, request):
        t = "Priority: %s" % request["priority"]
        return {"final_text": self._decide(request["option_a"], request["option_b"], t), "trace": None, "models_served": ["toy-1"]}

    def decide_restored(self, request, decision_input):
        t = "%s\nPriority: %s" % (decision_input, request["priority"])
        return {"final_text": self._decide(request["option_a"], request["option_b"], t), "trace": None, "models_served": ["toy-1"]}


class Base(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        ToyWorkflow.MEMORY = {}

    def p(self, n):
        return os.path.join(self.tmp.name, n)

    def ex(self, name, adapter, runs=1, orders=ch.ORDERS, config=None):
        code, paths, s = WF.execute(SC, adapter, self.p(name), runs, orders, config=config)
        return code, s, self.p(name)


class Conditions(Base):
    def test_plan_counts_and_conditions(self):
        code, s, d = self.ex("a", ToyWorkflow(leak=True), runs=2)    # leak: the toy decider sees (and follows) the priority
        self.assertEqual(code, 0)
        self.assertEqual(s["planned_executions"], 2 * 2 * 7); self.assertEqual(s["executions"], 28)
        self.assertEqual(s["conditions"], ["workflow", "workflow_no_priority", "direct", "restored"]); self.assertEqual(s["not_supported"], [])
        self.assertEqual(s["counts"]["workflow"]["A"]["MATCHED"], 4); self.assertEqual(s["counts"]["workflow_no_priority"]["A"]["UNCLEAR"], 4)
        self.assertTrue(s["fake_run"]); self.assertIn("NOT EVIDENCE", pathlib.Path(d, "report.md").read_text())

    def test_unsupported_conditions_are_never_run_and_are_labelled(self):
        ad = ToyWorkflow(direct=False, restored=False)
        code, s, d = self.ex("a", ad)
        self.assertEqual(s["conditions"], ["workflow", "workflow_no_priority"]); self.assertEqual(s["not_supported"], ["direct", "restored"])
        self.assertEqual(s["planned_executions"], 2 * 3)
        recs = [json.loads(x) for x in open(pathlib.Path(d, "records.jsonl"))]
        self.assertFalse(any(r["condition"] in ("direct", "restored") for r in recs))
        self.assertIn("NOT SUPPORTED by this adapter, so not tested:** direct, restored", pathlib.Path(d, "report.md").read_text())

    def test_no_priority_is_one_execution_scored_against_both_directions(self):
        code, s, d = self.ex("a", ToyWorkflow())
        recs = [json.loads(x) for x in open(pathlib.Path(d, "records.jsonl"))]
        ex = [r for r in recs if r["kind"] == "execution" and r["condition"] == "workflow_no_priority"]
        self.assertEqual(len(ex), 2)
        self.assertTrue(all(r["request"]["priority"] is None for r in ex))
        dec = [r for r in recs if r["kind"] == "decision" and r["condition"] == "workflow_no_priority"]
        self.assertEqual(sorted(r["direction"] for r in dec), ["A", "A", "B", "B"]); self.assertTrue(all(r["shared_execution"] for r in dec))

    def test_outcome_coding_by_option_text_in_both_orders(self):
        code, s, d = self.ex("a", ToyWorkflow(leak=True))
        recs = [json.loads(x) for x in open(pathlib.Path(d, "records.jsonl"))]
        for r in recs:
            if r["kind"] == "decision" and r["condition"] == "workflow":
                self.assertEqual(r["outcome"], "MATCHED"); self.assertEqual(r["chosen_option_text"], r["target_option_text"])
        bad = self.ex("b", ToyWorkflow(final="**FIRST CHOICE: A**"))[1]
        self.assertEqual(bad["counts"]["workflow"]["A"]["INVALID"], 2)

    def test_every_execution_gets_a_new_id(self):
        ad = ToyWorkflow()
        self.ex("a", ad, runs=2)
        self.assertEqual(len(ad.calls), len(set(ad.calls)))


class Exposure(Base):
    def test_carryover_between_executions_is_detected(self):
        code, s, d = self.ex("a", ToyWorkflow(memory=True))
        self.assertGreater(s["exposure_checks"]["no_priority_executions_with_priority_text"], 0)
        clean = self.ex("b", ToyWorkflow())[1]
        self.assertEqual(clean["exposure_checks"]["no_priority_executions_with_priority_text"], 0)

    def test_carryover_in_other_words_is_detected_and_restored_reuse_is_not(self):
        class Paraphrase(ToyWorkflow):
            """Keeps the previous execution's planner note (different wording from the priority) in memory."""
            LAST = {}
            def run(self, request):
                r = super().run(request)
                note = "NOTE (%s): carried over from the last customer, whose brief favoured a specific option" % request["execution_id"]
                prev = Paraphrase.LAST.get("note")
                if prev:
                    r["trace"]["agents"][1]["state_visible"]["memory"] = prev
                r["trace"]["agents"][0]["output"] = note
                Paraphrase.LAST["note"] = note
                return r
        Paraphrase.LAST = {}
        s = self.ex("a", Paraphrase())[1]
        self.assertGreater(s["exposure_checks"]["executions_with_earlier_execution_output"], 0)
        clean = self.ex("b", ToyWorkflow())[1]      # restored reuses its own workflow run's upstream: not carryover
        self.assertEqual(clean["exposure_checks"]["executions_with_earlier_execution_output"], 0)
        r = cmp.compare(cmp.load_run(self.p("b")), cmp.load_run(self.p("a")))
        self.assertEqual(r["verdict"], cmp.INVALID)

    def test_request_versus_state_is_distinguished(self):
        recs = [json.loads(x) for x in open(pathlib.Path(self.ex("a", ToyWorkflow(leak=True))[2], "records.jsonl"))]
        e = next(r for r in recs if r["kind"] == "execution" and r["condition"] == "workflow")
        where = {x["agent"]: x["where"] for x in e["exposure"]["given_priority_found"]}
        self.assertEqual(where, {"planner": "model request", "decider": "model request"})
        recs = [json.loads(x) for x in open(pathlib.Path(self.ex("b", ToyWorkflow(leak=False))[2], "records.jsonl"))]
        e = next(r for r in recs if r["kind"] == "execution" and r["condition"] == "workflow")
        where = {x["agent"]: x["where"] for x in e["exposure"]["given_priority_found"]}
        self.assertEqual(where, {"planner": "model request", "decider": "visible state only"})

    def test_missing_trace_is_reported_not_guessed(self):
        code, s, d = self.ex("a", ToyWorkflow())
        self.assertEqual(s["exposure_checks"]["executions_without_trace"], 8)   # the probes return no trace
        self.assertIn("absence does not show", s["exposure_checks"]["note"])


class CarryoverRule2(Base):
    """2026-11-23 regression tests (agent usability test B): deterministic, cached or temperature-0 workflows whose agents
    repeat template or task text must get a valid controlled comparison; genuine reuse of an earlier execution's output,
    and priority text in the no-priority control, must still be caught."""

    class Echo(ToyWorkflow):
        """intake -> researcher -> decider, fully deterministic (fresh state every call). The no-priority brief is a prefix
        of the priority brief, as in tester B's workflow: the pattern that rule 1 misread as carryover."""
        STALE = None                                   # when set to a dict, the researcher reuses an earlier report
        def run(self, request):
            pri = request["priority"]
            brief = "Brief for research. Goal: %s" % request["task"] + (("\nWhat the user said: %s" % pri) if pri else "")
            report = "Research report. Options reviewed: %s; %s. Recommendation pending the decision step." % (request["option_a"], request["option_b"])
            st = CarryoverRule2.Echo.STALE
            stale = ""
            if st is not None:                           # a wrongly keyed cache: the researcher's report differs per
                report = "Research report %s: on balance the user's stated concern points to one option." % request["execution_id"]
                stale = st.get("report", "")             # execution, and the PREVIOUS execution's report reaches the decider
                st["report"] = report
            d_req = "Decide between A: %s and B: %s.\n%s\n%s" % (request["option_a"], request["option_b"], report, stale)
            out = self._decide(request["option_a"], request["option_b"], brief + d_req)
            agents = [{"id": "intake", "role": "intake", "model": "toy-1", "request_messages": [{"role": "user", "content": "Task: %s" % request["task"]}],
                       "request_complete": True, "state_visible": None, "state_complete": True, "output": brief},
                      {"id": "researcher", "role": "research", "model": "toy-1", "request_messages": [{"role": "user", "content": brief}],
                       "request_complete": True, "state_visible": None, "state_complete": True, "output": report},
                      {"id": "decider", "role": "final decision", "model": "toy-1", "request_messages": [{"role": "user", "content": d_req}],
                       "request_complete": True, "state_visible": None, "state_complete": True, "output": out}]
            return {"final_text": out, "decision_input": report, "trace": {"format": WF.TRACE_FORMAT, "agents": agents}, "models_served": ["toy-1"]}

    def test_deterministic_template_echo_is_not_carryover_and_compares_validly(self):
        CarryoverRule2.Echo.STALE = None
        a = self.ex("a", CarryoverRule2.Echo(), runs=2)[1]
        b = self.ex("b", CarryoverRule2.Echo(), runs=2)[1]
        for s in (a, b):
            self.assertEqual(s["exposure_checks"]["executions_with_earlier_execution_output"], 0)
            self.assertEqual(s["exposure_checks"]["no_priority_executions_with_priority_text"], 0)
        r = cmp.compare(cmp.load_run(self.p("a")), cmp.load_run(self.p("b")))
        self.assertEqual(r["verdict"], cmp.SAME)

    def test_reused_earlier_output_is_still_caught_and_invalidates(self):
        CarryoverRule2.Echo.STALE = {}
        s = self.ex("c", CarryoverRule2.Echo(), runs=2)[1]
        self.assertGreater(s["exposure_checks"]["executions_with_earlier_execution_output"], 0)
        CarryoverRule2.Echo.STALE = None
        self.ex("d", CarryoverRule2.Echo(), runs=2)
        self.assertEqual(cmp.compare(cmp.load_run(self.p("d")), cmp.load_run(self.p("c")))["verdict"], cmp.INVALID)

    def test_priority_leak_into_no_priority_control_is_still_caught(self):
        CarryoverRule2.Echo.STALE = None
        s = self.ex("e", ToyWorkflow(memory=True), runs=2)[1]
        self.assertGreater(s["exposure_checks"]["no_priority_executions_with_priority_text"], 0)

    def test_new_records_carry_the_current_rule_and_older_rules_still_verify(self):
        CarryoverRule2.Echo.STALE = None
        d = self.ex("f", CarryoverRule2.Echo())[2]
        recs = [json.loads(x) for x in open(pathlib.Path(d, "records.jsonl"))]
        ex = [r for r in recs if r["kind"] == "execution" and r.get("trace")]
        self.assertTrue(ex and all(r.get("exposure_rule") == WF.EXPOSURE_RULE == 5 for r in ex))
        self.assertEqual(WF.recheck_exposure(recs, SC), [])
        for rule in (1, 2, 3, 4):                      # the same records as an older run would have stored them
            old, t = [], WF.ExposureTracker(SC)
            for r in recs:
                r = dict(r); r.pop("exposure_rule", None)
                if rule != 1:
                    r["exposure_rule"] = rule
                if r["kind"] == "execution" and r.get("exposure_checked"):
                    t.check(r)
                old.append(r)
            self.assertEqual(WF.recheck_exposure(old, SC), [])

    def test_carried_text_that_a_later_agent_repeats_is_still_caught(self):
        """Rule 3 (skeptic tester, 2026-11-23): a stale earlier brief reaches the researcher, who quotes it in its own
        output. Rule 2 counted the quote as 'explained by this execution's own output' and missed it."""
        class Quoting(CarryoverRule2.Echo):
            LAST = {}
            def run(self, request):
                r = super().run(request)
                ag = r["trace"]["agents"]
                prev = Quoting.LAST.get("brief")
                if prev:                               # the stale brief is in the researcher's request AND its output
                    ag[1]["request_messages"][0]["content"] += "\n" + prev
                    ag[1]["output"] = ag[1]["output"] + " Earlier brief: " + prev
                Quoting.LAST["brief"] = "Brief %s: this customer said reliability outweighed every other concern." % request["execution_id"]
                ag[0]["output"] = Quoting.LAST["brief"]
                return r
        Quoting.LAST = {}
        s = self.ex("q", Quoting(), runs=2)[1]
        self.assertGreater(s["exposure_checks"]["executions_with_earlier_execution_output"], 0)


class CarryoverRule4(Base):
    """Final skeptic test (2026-11-24): carried text in state with a quote, carryover through a traced memory step, and
    hidden session state must be caught; deterministic regeneration and shared boilerplate must not be flagged."""

    def flow(self, mode):
        class F(CarryoverRule2.Echo):
            MEM = {}
            def run(self, request):
                r = super().run(request); ag = r["trace"]["agents"]
                prev = F.MEM.get("rationale")
                rationale = "Rationale %s: the \"quiet\" option suits a household that values calm evenings." % request["execution_id"]
                if mode == "state_quote" and prev:
                    ag[1]["state_visible"] = {"memory": prev}
                if mode == "via_tool":
                    look = {"id": "memory_lookup", "role": "tool", "model": None, "request_messages": [{"role": "input", "content": "lookup key: household"}],
                            "request_complete": True, "state_visible": None, "state_complete": True, "output": prev or "no memory"}
                    ag.insert(1, look)
                    ag[2]["request_messages"][0]["content"] += "\nMEMORY: " + (prev or "none")
                if mode == "hidden" and prev:
                    ag[0]["output"] = ag[0]["output"] + " " + prev       # session history the trace does not show
                if mode == "hidden_embedded" and prev:                   # the same, inside a longer labelled line
                    ag[0]["output"] = ag[0]["output"] + "\nFrom our last chat: " + prev
                if mode == "regenerate":
                    rationale = "Standing note: our recommendations always weigh running costs against comfort over ten years."
                if mode == "shared_boilerplate":
                    ag[0]["output"] += " This advice was prepared by the household planning service for its members."
                    ag[2]["output"] += " This advice was prepared by the household planning service for its members."
                ag[-1]["output"] = ag[-1]["output"]
                ag[-2]["output"] = ag[-2]["output"] + " " + rationale     # the researcher's own output carries a rationale
                F.MEM["rationale"] = rationale
                return r
        F.MEM = {}
        return F()

    def flagged(self, mode, key="executions_with_earlier_execution_output"):
        CarryoverRule2.Echo.STALE = None
        s = self.ex(mode + "_" + key, self.flow(mode), runs=2)[1]
        return s["exposure_checks"].get(key, 0)

    def test_quote_in_state_is_caught(self):
        self.assertGreater(self.flagged("state_quote"), 0)

    def test_carryover_through_a_traced_memory_step_is_reported(self):
        # rule 5: an output-only finding is an ADVISORY "possible unrecorded source", not an invalidation
        self.assertGreater(self.flagged("via_tool", "executions_with_unrecorded_source_suspected"), 0)

    def test_hidden_session_state_is_reported(self):
        self.assertGreater(self.flagged("hidden", "executions_with_unrecorded_source_suspected"), 0)
        self.assertGreater(self.flagged("hidden_embedded", "executions_with_unrecorded_source_suspected"), 0)

    def test_deterministic_regeneration_and_shared_boilerplate_pass(self):
        for m in ("regenerate", "shared_boilerplate"):
            self.assertEqual(self.flagged(m), 0)
            self.assertEqual(self.flagged(m, "executions_with_unrecorded_source_suspected"), 0)


class CarryoverRule5(Base):
    """Fresh skeptic retest (2026-11-23): priority replayed into the control's OUTPUT, JSON-escaped accented carryover,
    a trace not in execution order, and a conditionally shared footer."""

    def flow(self, mode):
        class F(CarryoverRule2.Echo):
            MEM = {}
            def run(self, request):
                r = super().run(request); ag = r["trace"]["agents"]
                if mode == "hidden_priority" and request["priority"] is None and F.MEM.get("pri"):
                    ag[-1]["output"] += "\nFrom our earlier conversation: " + F.MEM["pri"]
                if request["priority"]:
                    F.MEM["pri"] = request["priority"]
                if mode == "escaped" :
                    note = "Résumé %s : la maison près du café reste l'option préférée de la dernière famille." % request["execution_id"]
                    prev = F.MEM.get("note")
                    if prev:
                        ag[2]["request_messages"][0]["content"] += "\nMEMORY: " + json.dumps({"m": prev})
                    ag[1]["output"] += " " + note; F.MEM["note"] = note
                if mode == "unordered":
                    ag.sort(key=lambda a: a["id"])
                if mode == "memory_into_intake":       # release reviewer (2026-11-24): a summarizer's fixed sentence is
                    summ = "Summary for the user: the decision followed the research report closely and carefully."
                    ag.append({"id": "summarizer", "role": "summary", "model": "toy-1", "request_complete": True, "state_visible": None,
                               "state_complete": True, "output": summ,
                               "request_messages": [{"role": "user", "content": "Summarize.\n" + ag[1]["output"]}]})
                    if F.MEM.get("summ"):              # kept in memory and put into the NEXT execution's intake request
                        ag[0]["request_messages"][0]["content"] += "\nSession history: " + F.MEM["summ"]
                    F.MEM["summ"] = summ
                if mode == "cond_footer":
                    foot = " Prices are indicative and may change before you book anything at all."
                    ag[1]["output"] += foot
                    if request["priority"] and request["direction"] == "B":
                        ag[0]["output"] += foot
                return r
        F.MEM = {}
        return F()

    def counts(self, mode):
        CarryoverRule2.Echo.STALE = None
        e = self.ex(mode, self.flow(mode), runs=2)[1]["exposure_checks"]
        return e

    def test_priority_replayed_into_the_control_output_invalidates(self):
        e = self.counts("hidden_priority")
        self.assertGreater(e["no_priority_executions_with_priority_text"], 0)
        self.assertEqual(cmp.compare(cmp.load_run(self.p("hidden_priority")), cmp.load_run(self.p("hidden_priority")))["verdict"], cmp.INVALID)

    def test_json_escaped_accented_carryover_is_caught(self):
        self.assertGreater(self.counts("escaped")["executions_with_earlier_execution_output"], 0)

    def test_memory_carryover_identical_to_this_executions_text_is_not_read_as_misordered(self):
        # the carried text equals what this execution produces later, so it looks like a listing error; the dependency
        # cycle (intake -> researcher -> summarizer -> intake) shows it is not one, and the run is invalidated
        e = self.counts("memory_into_intake")
        self.assertGreater(e["executions_with_earlier_execution_output"], 0)
        self.assertEqual(e.get("executions_with_trace_out_of_order", 0), 0)

    def test_unordered_trace_and_conditional_footer_do_not_invalidate(self):
        for m in ("unordered", "cond_footer"):
            e = self.counts(m)
            self.assertEqual(e["executions_with_earlier_execution_output"], 0, m)
            self.assertEqual(e["no_priority_executions_with_priority_text"], 0, m)


class Safety(Base):
    def test_served_model_outside_the_declared_ones_stops_the_run(self):
        code, s, d = self.ex("a", ToyWorkflow(served=["other-model"]))
        self.assertEqual(code, 4); self.assertIn("not in the adapter's declared", s["incomplete"])
        self.assertEqual(s["executions"], 1)

    def test_real_adapter_needs_cost_acceptance_and_exact_max(self):
        mod = self.p("realmod.py")
        pathlib.Path(mod).write_text("import sys\nsys.path.insert(0, %r)\nfrom test_workflow import ToyWorkflow\nclass Real(ToyWorkflow):\n"
                                     "    def __init__(self):\n        super().__init__(fake=False)\n" % str(ROOT / "tests"))
        sys.path.insert(0, self.tmp.name); self.addCleanup(sys.path.remove, self.tmp.name)
        sp = self.p("s.json"); pathlib.Path(sp).write_text(json.dumps(SC))
        for extra, msg in (([], "--i-accept-costs"), (["--i-accept-costs"], "--max-executions"), (["--i-accept-costs", "--max-executions", "3"], "--max-executions")):
            o, e = io.StringIO(), io.StringIO()
            with redirect_stdout(o), redirect_stderr(e):
                code = cli.main(["workflow", "--scenario", sp, "--adapter", "realmod:Real", "--out", self.p("o%d" % len(extra))] + extra)
            self.assertEqual(code, 2); self.assertIn(msg, e.getvalue())
            self.assertFalse(os.path.exists(self.p("o%d" % len(extra))))

    def test_alias_model_ids_are_refused(self):
        class Alias(ToyWorkflow):
            def describe(self):
                d = super().describe(); d["models"] = ["gpt-latest"]; return d
        with self.assertRaises(WF.AdapterError):
            WF.check_description(Alias().describe())


class CompareWorkflows(Base):
    def test_same_and_changed_configuration_and_invalid_against_chain(self):
        a, b = self.ex("a", ToyWorkflow())[2], self.ex("b", ToyWorkflow())[2]
        r = cmp.compare(cmp.load_run(a), cmp.load_run(b))
        self.assertEqual(r["verdict"], cmp.SAME); self.assertIn("workflow your adapter ran", " ".join(r["notes"]))
        c = self.ex("c", ToyWorkflow(), config={"prompt_version": 2})[2]
        r = cmp.compare(cmp.load_run(a), cmp.load_run(c))
        self.assertEqual(r["verdict"], cmp.CHANGED); self.assertEqual([d["field"] for d in r["differences"]], ["config.prompt_version"])
        lk = self.ex("d", ToyWorkflow(leak=True))[2]
        r = cmp.compare(cmp.load_run(a), cmp.load_run(lk))
        self.assertEqual(r["verdict"], cmp.CHANGED); self.assertIn("workflow_fingerprint", [d["field"] for d in r["differences"]])
        nd = self.ex("e", ToyWorkflow(direct=False))[2]
        self.assertEqual(cmp.compare(cmp.load_run(a), cmp.load_run(nd))["verdict"], cmp.INVALID)   # different conditions
        code, _, _ = ch.execute(SC, __import__("priority_check.providers", fromlist=["x"]).FakeChainProvider(SC), self.p("chain"), 1, ch.ORDERS, fake=True)
        r = cmp.compare(cmp.load_run(a), cmp.load_run(self.p("chain")))
        self.assertEqual(r["verdict"], cmp.INVALID)

    def test_tampered_workflow_records_are_refused(self):
        d = self.ex("a", ToyWorkflow())[2]
        rp, sp = pathlib.Path(d, "records.jsonl"), pathlib.Path(d, "summary.json")
        recs = [json.loads(x) for x in rp.read_text().splitlines()]
        for r in recs:
            if r["kind"] == "decision" and r["condition"] == "workflow":
                r["response_text"] = "FIRST CHOICE: %s" % ("B" if r["parsed"] == "A" else "A"); break
        rp.write_text("".join(json.dumps(r) + "\n" for r in recs))
        s = json.loads(sp.read_text()); s["records_sha256"] = ch.file_sha256(rp); sp.write_text(json.dumps(s))
        with self.assertRaises(cmp.Refused) as cm:
            cmp.load_run(d)
        self.assertIn("does not give its recorded outcome", str(cm.exception))
        d2 = self.ex("b", ToyWorkflow())[2]
        s = json.loads(pathlib.Path(d2, "summary.json").read_text()); s["workflow"]["fake"] = False; s["fake_run"] = False
        pathlib.Path(d2, "summary.json").write_text(json.dumps(s))
        with self.assertRaises(cmp.Refused):
            cmp.load_run(d2)

    def _edit(self, d, fn_sum=None, fn_recs=None, rehash=True):
        rp, sp = pathlib.Path(d, "records.jsonl"), pathlib.Path(d, "summary.json")
        recs = [json.loads(x) for x in rp.read_text().splitlines()]
        if fn_recs:
            recs = fn_recs(recs)
        rp.write_text("".join(json.dumps(r) + "\n" for r in recs))
        sm = json.loads(sp.read_text())
        if fn_sum:
            fn_sum(sm)
        if rehash:
            sm["records_sha256"] = ch.file_sha256(rp)
        sp.write_text(json.dumps(sm))
        return d

    def refused(self, d, msg):
        with self.assertRaises(cmp.Refused) as cm:
            cmp.load_run(d)
        self.assertIn(msg, str(cm.exception))

    def test_reviewer_attacks_2026_11_18(self):
        """Each was accepted before (agent-based adversarial review, workflow_review/); each is refused or invalid now."""
        ToyWorkflow.MEMORY = {}
        carry = self.ex("carry", ToyWorkflow(memory=True))[2]
        self._edit(carry, lambda sm: sm["exposure_checks"].update(no_priority_executions_with_priority_text=0))
        self.refused(carry, "exposure checks are not those of its own records")                       # P1
        ex = self.ex("cfg", ToyWorkflow(), config={"prompt_version": 2})[2]
        self._edit(ex, lambda sm: sm.update(config={}))
        self.refused(ex, "configuration is not the configuration recorded")                             # P2
        ns = self.ex("ns", ToyWorkflow())[2]
        self._edit(ns, lambda sm: sm.update(not_supported=["direct"]))
        self.refused(ns, "NOT SUPPORTED list")                                                          # P6
        ex2 = self.ex("exp", ToyWorkflow(leak=True))[2]
        def drop_found(recs):
            for r in recs:
                if r["kind"] == "execution" and r["condition"] == "workflow":
                    r["exposure"]["given_priority_found"] = []
                    break
            return recs
        self._edit(ex2, None, drop_found)
        self.refused(ex2, "does not match its own trace")
        a, b = self.ex("a", ToyWorkflow())[2], self.ex("b", ToyWorkflow())[2]                          # P9
        rid = json.loads(pathlib.Path(b, "summary.json").read_text())["run_id"]
        import shutil
        shutil.copytree(a, self.p("a2"))
        self._edit(self.p("a2"), lambda sm: sm.update(run_id=rid), lambda recs: [dict(r, run_id=rid) for r in recs])
        r = cmp.compare(cmp.load_run(a), cmp.load_run(self.p("a2")))
        self.assertEqual(r["verdict"], cmp.INVALID); self.assertIn("relabelled copy", r["headline"])

    def test_adapter_gates(self):
        class FakeReal(ToyWorkflow):
            def describe(self):
                d = super().describe(); d["models"] = ["claude-sonnet-5-5"]; return d
        with self.assertRaises(WF.AdapterError):
            WF.check_description(FakeReal().describe())                                                  # P8
        class NoMethod(ToyWorkflow):
            decide_direct = None
        with self.assertRaises(WF.AdapterError):
            WF.execute(SC, NoMethod(), self.p("nm"), 1, ch.ORDERS)                                       # supports without method
        code, s, d = self.ex("tm", type("TraceModel", (ToyWorkflow,), {"run": lambda self, q: dict(ToyWorkflow.run(self, q), models_served=[])})())
        self.assertEqual(code, 0)
        class Sneaky(ToyWorkflow):
            def run(self, q):
                r = super().run(q); r["models_served"] = ["toy-1"]; r["trace"]["agents"][1]["model"] = "other-9"; return r
        code, s, d = self.ex("sn", Sneaky())
        self.assertEqual(code, 4); self.assertIn("in the trace", s["incomplete"])                    # P7: trace model checked
        class RealNoServed(ToyWorkflow):
            def __init__(self):
                super().__init__(fake=False)
            def run(self, q):
                r = super().run(q); r["models_served"] = []; [ag.pop("model") for ag in r["trace"]["agents"]]; return r
        code, s, d = self.ex("rn", RealNoServed())
        self.assertEqual(code, 4); self.assertIn("reported no served model", s["incomplete"])          # P7: real needs it

    def test_trace_export(self):
        d = self.ex("a", ToyWorkflow())[2]
        recs = [json.loads(x) for x in open(pathlib.Path(d, "records.jsonl"))]
        e = next(r for r in recs if r["kind"] == "execution" and r["condition"] == "workflow")
        t = WF.export_trace(e, SC)
        self.assertEqual(t["format"], WF.TRACE_FORMAT); self.assertEqual(t["priority"], e["request"]["priority"])
        self.assertEqual([a["id"] for a in t["agents"]], ["planner", "decider"])


if __name__ == "__main__":
    unittest.main()


class MinimalExample(Base):
    """examples/minimal_workflow/my_adapter.py, as shown on the site's developer guide: the full change-retest-compare loop."""
    def test_change_retest_compare_is_valid_and_shows_the_fix(self):
        sys.path.insert(0, str(ROOT / "examples" / "minimal_workflow"))
        import my_adapter
        v1 = self.ex("v1", my_adapter.MyAdapter(), runs=2)[1]
        v2 = self.ex("v2", my_adapter.MyAdapter(), runs=2, config={"forward_priority": True})[1]
        for s in (v1, v2):
            self.assertEqual(s["exposure_checks"]["executions_with_earlier_execution_output"], 0)
            self.assertEqual(s["exposure_checks"]["no_priority_executions_with_priority_text"], 0)
        self.assertEqual(v1["paired"]["workflow"]["both_priorities_got_their_own_option"], 0)
        self.assertEqual(v2["paired"]["workflow"]["both_priorities_got_their_own_option"], 4)
        r = cmp.compare(cmp.load_run(self.p("v1")), cmp.load_run(self.p("v2")))
        self.assertEqual(r["verdict"], cmp.CHANGED)
