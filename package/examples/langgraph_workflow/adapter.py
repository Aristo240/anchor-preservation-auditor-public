"""The whole-workflow adapter for shop_graph.py: how a developer connects an EXISTING LangGraph system to priority_check.

    cd priority_check_kit
    PYTHONPATH=examples/langgraph_workflow python3 -m priority_check workflow \
        --scenario examples/langgraph_workflow/laptop.scenario.json --adapter adapter:ShopAdvisorAdapter \
        --runs 2 --out results/shop_v1

Everything the Auditor needs is here and nothing else changes in the developer's graph:
- run(): builds a NEW graph and a NEW model client for every request (fresh context, no checkpointer), puts the
  priority where this system normally receives it (the customer's profile note), and returns the decider's text and the
  per-node trace the graph already records.
- decide_direct() / decide_restored(): call the decider node alone. This system exposes its decision step, so both
  probes are supported; a system that doesn't would set them to False and they would be reported NOT SUPPORTED.

Configuration (passed with --config '{"personalize_decider": false}'; recorded in the run summary):
  personalize_decider  true (shipped; the defect) | false (the fix)
  share_memory         false (correct) | true: a deliberately WRONG integration that reuses one checkpointed thread
                       across requests, so state carries over; the Auditor's carryover check should catch it.
  budget               null | {"path": ledger.jsonl, "max_calls": N, "max_cost_usd": X, "input_usd_per_1m": p,
                       "output_usd_per_1m": q, "max_output_tokens": T, "chars_per_token": 2.0, "max_attempts": 2}:
                       every model call inside the workflow is capped and recorded (budget.py). Shared across runs.

The fake model is offline and deterministic; its output is NOT evidence about any model. For the fake only, the adapter
tells it which option the current priority favours (a real model would read the text).
"""
from __future__ import annotations

import importlib.metadata as _md
import warnings

warnings.filterwarnings("ignore", message=".*allowed_objects.*")   # a LangChain notice printed at import; unrelated
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

import shop_graph as SG
from budget import BudgetedModel, Ledger

_SHARED = {"saver": None}


def _versions():
    out = {}
    for p in ("langgraph", "langchain-core", "langgraph-checkpoint"):
        try:
            out[p] = _md.version(p)
        except _md.PackageNotFoundError:
            out[p] = None
    return out


class ShopAdvisorAdapter:
    def __init__(self, personalize_decider: bool = True, share_memory: bool = False, budget: dict = None):
        self.defaults = {"personalize_decider": personalize_decider, "share_memory": share_memory, "budget": budget}

    def describe(self):
        return {"name": "shop-advisor-langgraph", "version": "1.0", "fake": True, "provider": "fake",
                "models": ["fake-advisor-1"], "settings": {"framework": _versions(), "temperature": None},
                "agents": [{"id": "coordinator", "role": "coordinator"}, {"id": "cost_specialist", "role": "specialist"},
                           {"id": "care_specialist", "role": "specialist"}, {"id": "decider", "role": "final decision"}],
                "priority_entry": "the customer's profile note in the graph state (read by the coordinator)",
                "supports": {"direct": True, "restored": True}}

    # -------------------------------------------------------------------------------------------------- helpers
    def _cfg(self, request):
        c = dict(self.defaults)
        c.update({k: v for k, v in (request.get("config") or {}).items() if k in c})
        return c

    def _model(self, request):
        fav = {}
        if request.get("priority"):
            # fake only: which option the current priority favours, from the Auditor's request (direction + order)
            d, order = request["direction"], request["order"]
            original_a = request["option_a"] if order == "as_given" else request["option_b"]
            original_b = request["option_b"] if order == "as_given" else request["option_a"]
            fav[request["priority"]] = original_a if d == "A" else original_b
        m = SG.FakeChatModel(fav)
        b = self._cfg(request).get("budget")
        if b:   # every call inside the workflow goes through the ledger: capped before, recorded after
            b = dict(b)
            attempts = int(b.pop("max_attempts", 2))
            m = BudgetedModel(m, Ledger(**b), request["execution_id"], max_attempts=attempts)
        return m

    def _initial(self, request, cfg):
        s = {"request": request["task"], "option_a": request["option_a"], "option_b": request["option_b"], "trace": []}
        if request.get("priority") is not None:
            s["profile_note"] = request["priority"]
        elif not cfg["share_memory"]:
            s["profile_note"] = None
        return s          # with share_memory the WRONG integration omits the key, so an earlier value survives

    @staticmethod
    def _result(text, trace_agents, model, decision_input=None):
        return {"final_text": text, "decision_input": decision_input,
                "trace": {"format": "apa-trace/1", "framework": "langgraph", "agents": trace_agents},
                "models_served": [model.model_id], "errors": []}

    # -------------------------------------------------------------------------------------------------- contract
    def run(self, request):
        cfg = self._cfg(request)
        model = self._model(request)
        if cfg["share_memory"]:
            if _SHARED["saver"] is None:
                _SHARED["saver"] = InMemorySaver()
            graph = SG.build(model, cfg["personalize_decider"], checkpointer=_SHARED["saver"])
            out = graph.invoke(self._initial(request, cfg), config={"configurable": {"thread_id": "customer-42"}})
            agents = out["trace"][-4:]       # this request's four nodes (earlier ones belong to earlier requests)
        else:
            graph = SG.build(model, cfg["personalize_decider"])          # new graph, new state, no checkpointer
            out = graph.invoke(self._initial(request, cfg))
            agents = out["trace"]
        keys = ("request", "option_a", "option_b", "profile_note", "brief", "cost_report", "care_report")
        return self._result(out.get("decision"), agents, model, {k: out.get(k) for k in keys})

    def decide_direct(self, request):
        cfg = self._cfg(request)
        model = self._model(request)
        state = {"request": request["task"], "option_a": request["option_a"], "option_b": request["option_b"], "profile_note": None}
        out = SG.nodes(model, False, restored_priority=request["priority"])["decider"](state)
        return self._result(out["decision"], out["trace"], model)

    def decide_restored(self, request, decision_input):
        cfg = self._cfg(request)
        model = self._model(request)
        state = dict(decision_input, option_a=request["option_a"], option_b=request["option_b"])
        out = SG.nodes(model, cfg["personalize_decider"], restored_priority=request["priority"])["decider"](state)
        return self._result(out["decision"], out["trace"], model)
