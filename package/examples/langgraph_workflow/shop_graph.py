"""A small multi-agent purchase advisor built with LangGraph: it stands in for a developer's EXISTING system.

    coordinator ──► cost_specialist ─┐
                └─► care_specialist ─┴─► decider

- coordinator: reads the customer's request and stated priority from state; writes a brief for the specialists.
- cost_specialist / care_specialist: each reads ONLY the coordinator's brief and argues from its own angle.
- decider: is DESIGNED to read only the two specialist reports and return "FIRST CHOICE: A|B|UNCLEAR".

DELIBERATE DEFECT (for the Auditor to find): with `personalize_decider=True` (the default, "shipped" configuration),
a "personalization helper" also copies the customer's profile note, which holds the stated priority, into the decider's
model request. The developer's declared architecture says the decider sees only the specialist reports.
Setting `personalize_decider=False` is the fix. Separately, every node can READ the whole graph state, including the
profile, even when its model request doesn't include it: the trace records both, so "available in state" and
"actually sent to the model" can be told apart.

Models are pluggable: any object with .invoke(messages) -> str and .model_id. `FakeChatModel` is deterministic and
offline (its output is NOT evidence about any model). Each node records the exact messages it sent and the state it
could see, which is the instrumentation the Auditor's whole-workflow adapter reads.
"""
from __future__ import annotations

import operator
import re
from typing import Annotated, Dict, List, Optional, TypedDict

from langgraph.graph import END, START, StateGraph


class AdvisorState(TypedDict, total=False):
    request: str
    option_a: str
    option_b: str
    profile_note: Optional[str]          # the customer's stated priority, if any
    brief: str
    cost_report: str
    care_report: str
    decision: str
    trace: Annotated[List[dict], operator.add]


COORDINATOR = ("You coordinate a purchase-advice team. Write a short brief for two specialists.\n"
               "Customer request: {request}\nOPTION A: {a}\nOPTION B: {b}\n{priority_line}")
COST = ("You are the cost specialist. Using only this brief, say which option is better on total cost and practical "
        "constraints.\n\nBRIEF:\n{brief}")
CARE = ("You are the care specialist. Using only this brief, say which option is better for the customer's wellbeing and "
        "relationships.\n\nBRIEF:\n{brief}")
DECIDER = ("You make the final recommendation for the customer.\nOPTION A: {a}\nOPTION B: {b}\n{profile}"
           "COST SPECIALIST:\n{cost}\n\nCARE SPECIALIST:\n{care}\n\n{reminder}"
           "Give your choice on the first line in exactly this form: FIRST CHOICE: A, FIRST CHOICE: B, or FIRST CHOICE: UNCLEAR.")


class FakeChatModel:
    """Deterministic offline stand-in. `favours` maps a priority text to the option text it favours (the scenario's own
    mapping), so the fake can 'follow' a priority it is shown verbatim. It never reads anything it was not sent."""

    def __init__(self, favours: Dict[str, str], model_id: str = "fake-advisor-1"):
        self.favours, self.model_id, self.calls = dict(favours), model_id, 0

    def _option(self, text, letter):
        m = re.search(r"^OPTION %s: (.*)$" % letter, text, re.M)
        return m.group(1).strip() if m else None

    def invoke(self, messages: List[dict]) -> str:
        self.calls += 1
        text = "\n".join(m["content"] for m in messages)
        stated = next((p for p in self.favours if p in text), None)
        if text.startswith("You coordinate"):
            if stated:
                return "BRIEF: the customer leans towards \"%s\"; check it against costs and wellbeing." % self.favours[stated]
            return "BRIEF: no stated preference; compare both options."
        if text.startswith("You are the cost specialist"):
            lean = re.search(r'leans towards "(.*)"', text)
            return "COST VIEW: %s" % (("prefer \"%s\"" % lean.group(1)) if lean else "the cheaper option is usually safer")
        if text.startswith("You are the care specialist"):
            return "CARE VIEW: prefer whichever option keeps people together; this brief does not settle it."
        if text.startswith("You make the final recommendation"):
            a, b = self._option(text, "A"), self._option(text, "B")
            if stated:
                fav = self.favours[stated]
                return "FIRST CHOICE: %s\nFollowing the customer's stated priority." % ("A" if fav == a else "B")
            lean = re.search(r'prefer "(.*)"', text)
            if lean and lean.group(1) in (a, b):
                return "FIRST CHOICE: %s\nThe cost specialist's argument is the most concrete." % ("A" if lean.group(1) == a else "B")
            return "FIRST CHOICE: UNCLEAR\nThe reports do not settle it."
        return "UNRECOGNISED PROMPT"


def _record(state, node, role, model, messages, output, visible_keys):
    vis = {k: state.get(k) for k in visible_keys if k in state}
    fake = isinstance(model, FakeChatModel) or isinstance(getattr(model, "inner", None), FakeChatModel)
    return {"id": node, "role": role, "model": model.model_id, "provider": "fake" if fake else "custom",
            "settings": {}, "request_messages": messages, "request_complete": True,
            "state_visible": vis, "state_complete": True, "output": output, "usage": getattr(model, "last_usage", None), "error": None}


def _for(model, agent):
    """A per-agent view of the model client, if it has one (the budget wrapper records which agent made each call)."""
    return model.for_agent(agent) if hasattr(model, "for_agent") else model


def nodes(base_model, personalize_decider: bool = True, restored_priority: Optional[str] = None):
    """The four node functions. `restored_priority` (used only by the Auditor's restored probe) adds the priority as
    one line at the decision step."""
    STATE_KEYS = ("request", "option_a", "option_b", "profile_note", "brief", "cost_report", "care_report")

    def coordinator(s: AdvisorState):
        model = _for(base_model, "coordinator")
        line = ("Customer priority: %s\n" % s["profile_note"]) if s.get("profile_note") else ""
        msgs = [{"role": "user", "content": COORDINATOR.format(request=s["request"], a=s["option_a"], b=s["option_b"], priority_line=line)}]
        out = model.invoke(msgs)
        return {"brief": out, "trace": [_record(s, "coordinator", "coordinator", model, msgs, out, STATE_KEYS)]}

    def cost_specialist(s: AdvisorState):
        model = _for(base_model, "cost_specialist")
        msgs = [{"role": "user", "content": COST.format(brief=s["brief"])}]
        out = model.invoke(msgs)
        return {"cost_report": out, "trace": [_record(s, "cost_specialist", "specialist", model, msgs, out, STATE_KEYS)]}

    def care_specialist(s: AdvisorState):
        model = _for(base_model, "care_specialist")
        msgs = [{"role": "user", "content": CARE.format(brief=s["brief"])}]
        out = model.invoke(msgs)
        return {"care_report": out, "trace": [_record(s, "care_specialist", "specialist", model, msgs, out, STATE_KEYS)]}

    def decider(s: AdvisorState):
        model = _for(base_model, "decider")
        profile = ("Customer profile note: %s\n" % s["profile_note"]) if (personalize_decider and s.get("profile_note")) else ""
        reminder = ("USER PRIORITY: %s\n" % restored_priority) if restored_priority else ""
        msgs = [{"role": "user", "content": DECIDER.format(a=s["option_a"], b=s["option_b"], profile=profile,
                                                           cost=s.get("cost_report", "(none)"), care=s.get("care_report", "(none)"), reminder=reminder)}]
        out = model.invoke(msgs)
        return {"decision": out, "trace": [_record(s, "decider", "final decision", model, msgs, out, STATE_KEYS)]}

    return {"coordinator": coordinator, "cost_specialist": cost_specialist, "care_specialist": care_specialist, "decider": decider}


def build(model, personalize_decider: bool = True, checkpointer=None):
    """Returns the compiled graph: coordinator -> two specialists in parallel -> decider."""
    fns = nodes(model, personalize_decider)
    g = StateGraph(AdvisorState)
    for name, fn in fns.items():
        g.add_node(name, fn)
    g.add_edge(START, "coordinator")
    g.add_edge("coordinator", "cost_specialist")
    g.add_edge("coordinator", "care_specialist")
    g.add_edge(["cost_specialist", "care_specialist"], "decider")
    g.add_edge("decider", END)
    return g.compile(checkpointer=checkpointer)
