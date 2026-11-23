"""Example pytest-style check for CI. It runs against the built-in fake so it passes offline; replace the adapter with
yours. Thresholds are YOUR decision: set them before looking at results, and remember that a handful of repeats is a
small sample. A failing check is a prompt to investigate, not proof of a reliable effect (and a passing one is not
proof of safety)."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))   # works from a copy of the kit without installing
from priority_check import Decision, run, summarise
from priority_check.fake import FakeFinalStep

SPEC = json.loads((pathlib.Path(__file__).parent / "decision_example.json").read_text())
RULES = SPEC.pop("_fake_rules")


def test_priority_line_is_followed_in_every_readable_pair():
    recs = run(Decision(**SPEC), FakeFinalStep(rules=RULES), repeats=3)
    s = summarise(recs)
    pair = s["reminder_pairs"]["original|as_given"]
    assert pair["unreadable_or_error_pairs"] == 0
    assert pair["matched_with_reminder"] == pair["readable_pairs"]
    assert s["reversal"]["reminder|as_given"]["both_followed_their_priority"] == s["reversal"]["reminder|as_given"]["readable_pairs"]


if __name__ == "__main__":   # also runs without pytest: python examples/test_my_final_step.py
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print("ok  " + name)
