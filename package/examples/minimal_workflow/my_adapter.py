"""The smallest whole-workflow adapter: intake -> researcher -> decider, plain Python, offline fake model (its output is
NOT evidence about any model). Replace `fake_model` with your own model call and the three steps with your own agents.

    cd priority_check-0.1.0b1        # the folder you extracted the package into
    PYTHONPATH=examples/minimal_workflow python3 -m priority_check workflow --scenario examples/chain_scenario.example.json \
        --adapter my_adapter:MyAdapter --runs 2 --orders both --out results_v1
    # change: pass the user's words on to the researcher, then retest and compare
    PYTHONPATH=examples/minimal_workflow python3 -m priority_check workflow --scenario examples/chain_scenario.example.json \
        --adapter my_adapter:MyAdapter --runs 2 --orders both --config '{"forward_priority": true}' --out results_v2
    python3 -m priority_check compare --baseline results_v1 --candidate results_v2
"""
import json, pathlib

TRACE = "apa-trace/1"
_HERE = pathlib.Path(__file__).resolve().parent
# The fake model needs the example scenario's priorities; found next to this file, in examples/, or under the current
# folder, so a copy of this adapter placed anywhere in the package folder still runs.
_SCN = next((p for p in (_HERE / "chain_scenario.example.json", _HERE.parent / "chain_scenario.example.json",
                         pathlib.Path.cwd() / "examples" / "chain_scenario.example.json", pathlib.Path.cwd() / "chain_scenario.example.json")
             if p.is_file()), None)
if _SCN is None:
    raise SystemExit("my_adapter.py: chain_scenario.example.json not found next to this file, in examples/, or in the current folder")
_SC = json.loads(_SCN.read_text())
FAVOURS = {_SC["priority_A"]: _SC["option_a"], _SC["priority_B"]: _SC["option_b"]}   # what the fake "prefers" per priority


def fake_model(prompt):
    """Deterministic stand-in for a model call: picks the option a priority in the prompt favours, else declines."""
    if prompt.startswith("Decide"):
        a = prompt.split("OPTION A: ")[1].split("\n")[0]
        p = next((p for p in FAVOURS if p in prompt), None)
        return ("FIRST CHOICE: %s" % ("A" if FAVOURS[p] == a else "B")) if p else "FIRST CHOICE: UNCLEAR"
    if prompt.startswith("Research"):
        return "Findings: both options are workable.\n" + ("User priority: " + prompt.split("User priority: ")[1] if "User priority: " in prompt else "")
    return "Brief: " + prompt


class MyAdapter:
    def describe(self):
        return {"name": "my-minimal-workflow", "version": "1", "fake": True, "provider": "fake", "models": ["fake-minimal-1"],
                "settings": {}, "agents": [{"id": "intake", "role": "intake"}, {"id": "researcher", "role": "research"},
                                           {"id": "decider", "role": "final decision"}],
                "priority_entry": "intake prompt", "supports": {"direct": True, "restored": True}}

    def _agent(self, aid, prompt):
        out = fake_model(prompt)
        return out, {"id": aid, "role": aid, "model": "fake-minimal-1", "provider": "fake", "request_messages": [{"role": "user", "content": prompt}],
                     "request_complete": True, "state_visible": None, "state_complete": True, "output": out}

    def _decide(self, req, upstream, priority=None):
        prompt = "Decide for the user.\nOPTION A: %s\nOPTION B: %s\n%s%s" % (req["option_a"], req["option_b"], upstream,
                                                                          ("\nUser priority: %s" % priority) if priority else "")
        return self._agent("decider", prompt)

    def run(self, request):                       # the WHOLE workflow, once, with fresh state
        pri = request.get("priority")
        brief, a1 = self._agent("intake", "Task: %s" % request["task"] + (("\nUser priority: %s" % pri) if pri else ""))
        forward = (request.get("config") or {}).get("forward_priority")
        res_prompt = "Research the options.\n" + (brief if forward else brief.split("\nUser priority:")[0])
        notes, a2 = self._agent("researcher", res_prompt)
        out, a3 = self._decide(request, notes)
        return {"final_text": out, "decision_input": notes, "trace": {"format": TRACE, "agents": [a1, a2, a3]}, "models_served": ["fake-minimal-1"]}

    def decide_direct(self, request):              # the decision step alone, given the priority
        out, a = self._decide(request, "", request["priority"])
        return {"final_text": out, "trace": {"format": TRACE, "agents": [a]}, "models_served": ["fake-minimal-1"]}

    def decide_restored(self, request, decision_input):   # the same upstream input plus the priority restated
        out, a = self._decide(request, decision_input, request["priority"])
        return {"final_text": out, "trace": {"format": TRACE, "agents": [a]}, "models_served": ["fake-minimal-1"]}
