"""Template: connect priority_check to YOUR final decision step. Copy this file into your project and edit.

Choose ONE of the two adapter styles.

1) Prompt adapter (simplest): your final step can take the study's prompt text as its input.
   It must return the step's raw text answer. Keep everything else (model, settings, system prompt, code path) exactly
   as in production, and start each call fresh (no conversation memory between calls).

2) Workflow adapter: your final step builds its own prompt. Implement decide(); when `priority` is None, do NOT add the
   user's priority; when it is a string, add it in the place your system would. The answer's first line must be
   'FIRST CHOICE: A', 'FIRST CHOICE: B' or 'FIRST CHOICE: UNCLEAR' (add that instruction to your step for this test).
"""


def my_final_step(prompt: str) -> str:            # style 1
    raise NotImplementedError("call your final decision step with `prompt` and return its raw text")


class MyWorkflow:                                   # style 2
    def decide(self, task, option_a, option_b, step_input, priority):
        raise NotImplementedError("call your final step with these fields; include `priority` only if it is not None")
