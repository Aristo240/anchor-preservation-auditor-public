"""Command line: python -m priority_check run --spec decision.json --adapter my_module:name --repeats 5 --out results/

--adapter module:name names one of:
  - a function taking the prompt text and returning the raw answer (a prompt adapter);
  - an object with a decide(task, option_a, option_b, step_input, priority) method (a workflow adapter);
  - a class, instantiated with no arguments, whose instances are either of the above.
--fake uses the built-in deterministic fake instead (no model); its rules come from the spec's "_fake_rules".

Records are written to <out>/records.jsonl one by one as they finish. The output directory must be new or empty.
If the run is interrupted, the summary of the finished records is still written and marked incomplete.

Subcommand `chain` tests the fixed six-handoff workflow on your own scenario: see `python -m priority_check chain --help`.
Subcommand `workflow` tests YOUR whole multi-agent workflow through an adapter: see `python -m priority_check workflow --help`.
Subcommand `compare` compares a new `chain` or `workflow` run with an earlier one: see `python -m priority_check compare --help`.

Exit codes (run): 0 finished with at least one readable with/without pair; 2 refused (output directory not empty, or invalid arguments);
3 finished but no with/without pair was readable (every call failed or gave an unreadable answer: check the adapter);
130 interrupted. A warning on stderr reports errors and unreadable answers whenever there are any."""
import argparse
import importlib
import json
import sys

from .core import Decision, RecordWriter, prepare_out_dir, run, summarise, write_summary


def load_adapter(spec):
    mod, _, name = spec.partition(":")
    if not name:
        raise SystemExit("--adapter must be module:name")
    obj = getattr(importlib.import_module(mod), name)
    if isinstance(obj, type):
        obj = obj()
    if not (callable(obj) or hasattr(obj, "decide")):
        raise SystemExit("%s is neither callable (prompt adapter) nor has decide() (workflow adapter)" % spec)
    return obj


def main(argv=None):
    ap = argparse.ArgumentParser(prog="priority_check")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="test your own final step: the same decision with and without the priority line")
    r.add_argument("--spec", required=True, help="JSON file with the Decision fields")
    g = r.add_mutually_exclusive_group(required=True)
    g.add_argument("--adapter", help="module:name of your final step (see above)")
    g.add_argument("--fake", action="store_true", help="built-in deterministic fake (dry run, uses the spec's _fake_rules)")
    def positive(v):
        n = int(v)
        if n < 1:
            raise argparse.ArgumentTypeError("--repeats must be at least 1")
        return n
    r.add_argument("--repeats", type=positive, default=5)
    r.add_argument("--no-reverse", action="store_true"); r.add_argument("--no-swap", action="store_true")
    r.add_argument("--run-id", help="label for this run (default: the start time in UTC)")
    r.add_argument("--out", required=True, help="a new or empty directory; existing results are never overwritten")
    from .chain_cli import add_chain_parser, main_chain
    from .compare import add_compare_parser, main_compare
    from .workflow import add_workflow_parser, main_workflow
    add_chain_parser(sub)
    add_workflow_parser(sub)
    add_compare_parser(sub)
    a = ap.parse_args(argv)
    if a.cmd == "chain":
        return main_chain(a)
    if a.cmd == "compare":
        return main_compare(a)
    if a.cmd == "workflow":
        return main_workflow(a)
    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)
    d = Decision(**{k: v for k, v in spec.items() if not k.startswith("_")})
    if a.fake:
        from .fake import FakeFinalStep
        adapter = FakeFinalStep(rules=spec.get("_fake_rules", []))
    else:
        adapter = load_adapter(a.adapter)
    try:
        out = prepare_out_dir(a.out)
    except FileExistsError as e:
        print("refused: %s" % e, file=sys.stderr)
        return 2
    w, recs, code = RecordWriter(out), [], 0
    try:
        recs = run(d, adapter, repeats=a.repeats, reverse=not a.no_reverse, swap=not a.no_swap, run_id=a.run_id, sink=w.write)
        s = summarise(recs)
    except KeyboardInterrupt:
        with open(w.path, encoding="utf-8") as f:
            recs = [json.loads(line) for line in f]
        s = summarise(recs)
        s["incomplete"] = "interrupted after %d finished calls; the summary covers only those records" % len(recs)
        code = 130
    finally:
        w.close()
    paths = {"records": str(w.path)}
    paths.update(write_summary(s, out))
    print(json.dumps(paths, indent=1))
    bad = sum(1 for r in recs if r["outcome"] in ("error", "invalid"))
    if bad:
        print("warning: %d of %d calls gave an error or an unreadable answer; see records.jsonl" % (bad, len(recs)), file=sys.stderr)
    if code == 0 and not any(p["readable_pairs"] for p in s["reminder_pairs"].values()):
        print("no with/without pair was readable: the results say nothing about the priority. Check the adapter.", file=sys.stderr)
        code = 3
    return code


if __name__ == "__main__":
    sys.exit(main())
