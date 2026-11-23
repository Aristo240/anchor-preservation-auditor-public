"""Framework-portability check (offline): the kit's fixed six-handoff reference workflow re-implemented as a LangGraph
graph, compared call by call with the kit's own `chain` implementation on the same scenario.

    <python-with-langgraph> examples/langgraph_workflow/reference_chain_graph.py [scenario.json]

Both implementations are driven by the same deterministic fake model, which records every prompt it receives. The
check compares the canonical model-visible request text of every call, in order, and the handoff boundaries (which
call's output is passed into which next call). It reports differences rather than assuming equivalence. This is a
technical compatibility check, NOT a new scientific result, and it makes no model calls.
"""
from __future__ import annotations

import json
import operator
import pathlib
import sys
import warnings
from typing import Annotated, List, Optional, TypedDict

warnings.filterwarnings("ignore")
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
from langgraph.graph import END, START, StateGraph            # noqa: E402
from priority_check import chain as ch                         # noqa: E402
from priority_check.core import build_prompt                   # noqa: E402
from priority_check.providers import FakeChainProvider         # noqa: E402


class Recording(FakeChainProvider):
    """The kit's fake chain provider, also recording (prompt, output) for every call."""
    def __init__(self, sc):
        super().__init__(sc)
        self.log = []

    def complete(self, prompt):
        text, served = super().complete(prompt)
        self.log.append({"prompt": prompt, "output": text})
        return text, served


class ChainState(TypedDict, total=False):
    task: str
    a: str
    b: str
    priority: Optional[str]
    prev: Optional[str]
    n: int
    outputs: Annotated[List[str], operator.add]


def langgraph_chain(provider, task, a, b, priority):
    """Six handoffs as six LangGraph nodes; each node sees only the previous node's output (handoff 1: the task)."""
    def make(n):
        def node(s: ChainState):
            prompt = ch.handoff_prompt(n, s.get("prev"), s["task"], s["a"], s["b"], s.get("priority"))
            text, _ = provider.complete(prompt)
            return {"prev": text, "n": n, "outputs": [text]}
        return node
    g = StateGraph(ChainState)
    for n in range(1, ch.N_HANDOFFS + 1):
        g.add_node("h%d" % n, make(n))
    g.add_edge(START, "h1")
    for n in range(1, ch.N_HANDOFFS):
        g.add_edge("h%d" % n, "h%d" % (n + 1))
    g.add_edge("h%d" % ch.N_HANDOFFS, END)
    return g.compile().invoke({"task": task, "a": a, "b": b, "priority": priority, "prev": None, "outputs": []})


def langgraph_run(sc):
    """The same design as chain.run_chain (one run), driven through LangGraph for the handoffs."""
    prov = Recording(sc)
    task = ch.task_text(sc)
    for order in ch.ORDERS:
        a, b = (sc["option_a"], sc["option_b"]) if order == "as_given" else (sc["option_b"], sc["option_a"])
        for d in ch.DIRECTIONS:
            pri = sc["priority_A"] if d == "A" else sc["priority_B"]
            t6 = {}
            for arm, p in (("with_priority", pri), ("no_priority", None)):
                t6[arm] = langgraph_chain(prov, task, a, b, p)["prev"]
            for cond, handoff, line in (("direct", "", pri), ("delegated", t6["with_priority"], None), ("restored", t6["with_priority"], pri),
                                        ("direct_no_priority", "", None), ("chain_no_priority", t6["no_priority"], None)):
                prov.complete(build_prompt(task, a, b, handoff, line))
    return prov.log


def kit_run(sc):
    prov = Recording(sc)
    ch.run_chain(sc, prov, runs=1)
    return prov.log


def boundaries(log):
    """For each call, the index of the earlier call whose output appears verbatim in its prompt (the handoff edge)."""
    out = []
    for i, c in enumerate(log):
        src = [j for j in range(i) if log[j]["output"] and log[j]["output"] in c["prompt"]]
        out.append(src[-1] if src else None)
    return out


def check(sc) -> dict:
    k, g = kit_run(sc), langgraph_run(sc)
    diffs = [i for i, (x, y) in enumerate(zip(k, g)) if x["prompt"] != y["prompt"]]
    return {"scenario_id": sc["scenario_id"], "calls_kit": len(k), "calls_langgraph": len(g),
            "identical_request_text": sum(1 for x, y in zip(k, g) if x["prompt"] == y["prompt"]),
            "first_differences": diffs[:5], "handoff_boundaries_identical": boundaries(k) == boundaries(g),
            "settings_compared": "fake provider only: no sampling or token settings are sent; a real-model comparison would also compare request parameters",
            "note": "Technical compatibility only (same request text and handoff boundaries under a deterministic fake). Not a scientific result."}


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else HERE.parents[0] / "chain_scenario.example.json"
    print(json.dumps(check(ch.load_scenario(path)), indent=1))
