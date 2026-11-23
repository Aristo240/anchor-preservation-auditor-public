"""Deterministic fake final steps for offline tests and dry runs. No network."""
import hashlib
import re


class FakeFinalStep:
    """A prompt adapter. `rules` is a list of (priority_keyword, option_text_fragment) pairs. Rules:
      - if the prompt has a 'USER PRIORITY:' line whose part before " more " contains a priority_keyword, choose the
        option whose text contains the matching fragment (UNCLEAR if no rule matches);
      - otherwise follow `default` ('A', 'B' or 'UNCLEAR'), i.e. ignore the earlier input entirely;
      - `noise`: fraction (0..1) of calls, chosen by a hash of (prompt, call number), answered with a Markdown-bold
        first line (strictly INVALID) to exercise parsing.
    """

    def __init__(self, rules, default="A", noise=0.0):
        self.rules, self.default, self.noise, self.calls = [(k.lower(), f.lower()) for k, f in rules], default, noise, 0

    def __call__(self, prompt):
        self.calls += 1
        h = int(hashlib.sha256(("%s|%d" % (prompt, self.calls)).encode("utf-8", "surrogatepass")).hexdigest()[:8], 16) / 0xFFFFFFFF
        m = re.search(r"^USER PRIORITY: (.*)$", prompt, re.M)
        choice = self.default
        if m:
            frag = next((f for k, f in self.rules if k in m.group(1).split(" more ")[0].lower()), None)
            a = re.search(r"^OPTION A: (.*)$", prompt, re.M).group(1).lower()
            choice = ("A" if frag in a else "B") if frag else "UNCLEAR"
        first = "FIRST CHOICE: %s" % choice
        if h < self.noise:
            first = "**%s**" % first
        return first + "\nBecause of the fixed fake rule."


class FakeWorkflow:
    """A workflow adapter (own prompt format): decide(task, option_a, option_b, step_input, priority) -> str."""

    def __init__(self, rules):
        self.rules = [(k.lower(), f.lower()) for k, f in rules]

    def decide(self, task, option_a, option_b, step_input, priority):
        if priority is None:
            return "FIRST CHOICE: UNCLEAR\nNo priority given."
        frag = next((f for k, f in self.rules if k in priority.split(" more ")[0].lower()), None)
        return "FIRST CHOICE: %s\n" % (("A" if frag in option_a.lower() else "B") if frag else "UNCLEAR")
