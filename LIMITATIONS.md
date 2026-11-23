# Limitations

## The research
- **Study 4** used one model (Gemini 2.5 Pro), 12 constructed scenarios and a fixed six-handoff workflow (advisor,
  critic, summarizer, twice). It shows what happened in that controlled setting, not how often it happens in other
  workflows. Bootstrap intervals over 12 scenario clusters are descriptive.
- The handoff texts were not analysed for the headline, so the results cannot say whether the priority was lost from
  the text or present but unused.
- A separate exploratory coordinator workflow (Gemini 3.8 Flash, 7 dilemmas, two analysts) stayed fully sensitive to
  the priority. Priority sensitivity differs between workflows, which is why the tool tests individual systems.
- The three-model comparison is exploratory and is never pooled with Study 4.
- **What you can recompute here:** the Study 4 headline numbers, from the released per-decision outcome rows
  (`research/reproduce_study4.py`). **What you cannot:** the coding of each model answer, which needs the raw API
  responses. These are not published because they include the model's thinking summaries; their hashes are.
- Some source texts in the dilemma library are withheld because their reuse licence is not established (see
  THIRD_PARTY_NOTICES.md); the library shows their titles and a pointer to the source.

## The tool (`priority_check` and the site's developer pages)
- **Exact-text integrity checks.** A run is marked invalid when:
  - an agent's input (its request, or its visible state) contains a sentence from an earlier execution that it
    could not have received in this one;
  - the priority's text appears anywhere in a no-priority execution;
  - the opposite priority's text appears anywhere in an execution.
  An agent's *output* carrying another agent's earlier sentence that its recorded input lacks is reported as an
  advisory only.
- **Not detected:**
  - paraphrased leaks;
  - carried option text;
  - carryover shorter than a sentence;
  - a cache that replays an agent's own earlier output;
  - some memory paths that cannot be told apart reliably from legitimate behaviour: memory not recorded in the trace
    (reported only as an advisory), and memory carrying text identical to text the execution itself produces later,
    when the recorded order is ambiguous (it can be read as a trace listing error);
  - anything your instrumentation does not record.
  The behavioural measures are the backstop: decisions that do not follow the priority, or a no-priority control that
  always picks one option, are reported.
- The tool shows *that* the priority stopped influencing the decision and where its exact text stopped. It does not
  name the step that dropped it.
- A few repetitions show a pattern worth investigating, not a reliable effect size.
- **Evidence behind the developer path:**
  - All developer-path examples use a fake model.
  - The tool has not yet been run with a real model on a third-party workflow.
  - The OpenRouter provider follows OpenRouter's documentation and has not been tested against the live service by an
    independent developer.
- **Usability:** usability was evaluated with AI agents acting as visitors and developers, not with human
  participants. No human usability study has been done.
- One scenario per run. No importers for other trace formats (LangSmith, OpenTelemetry). Your adapter writes the
  `apa-trace/1` format.
