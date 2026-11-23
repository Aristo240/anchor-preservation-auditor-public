#!/usr/bin/env python3
"""Recompute the publicly reported Study 4 headline numbers from the released per-decision outcomes, and FAIL (exit 1)
if any number differs from what the site reports.

    python3 research/reproduce_study4.py            # reads site/assets/study4_results.js
    python3 research/reproduce_study4.py FILE        # or another copy of that file

Input: the 456 per-decision outcome rows of Study 4 (Gemini 2.5 Pro, 12 constructed scenarios), as shipped with the
site. Each row holds ids and coded outcomes only (condition, scenario id, option order, chain, the parsed answer and
whether it matched the stated priority); no prompts, handoff texts or model answers. The script checks the rows against
the SHA-256 recorded when they were generated, recomputes everything below from the rows with its own code, and compares
with the published values. Standard library only.

What this does NOT reproduce: the coding of each model answer (that needs the raw API responses, which are not
published) and the run itself. See research/README.md.
"""
import collections, hashlib, json, pathlib, random, statistics, sys

PUBLISHED = {                       # as stated on the site (home page, Study 4 page) and in the findings
    "paired_sensitive": {"direct": (24, 24), "delegated": (6, 48), "restored": (47, 48)},
    "decisions_matched": {"direct": (48, 48), "delegated": (27, 96), "restored": (95, 96)},
    "delegated_outcomes": {"matched": 27, "opposite": 35, "unclear": 34},
    "P1_direct_minus_delegated": {"mean": 0.875, "ci95": [0.75, 0.9792]},
    "P2_restored_minus_delegated": {"mean": 0.8542, "ci95": [0.7292, 0.9583]},
    "rows": 456, "scenarios": 12,
}
B, SEED = 10000, 20261113            # percentile bootstrap over scenarios, as preregistered for the analysis


def load(path):
    s = pathlib.Path(path).read_text(encoding="utf-8")
    obj = json.loads(s[s.index("=") + 1:].strip().rstrip(";")) if s.lstrip().startswith(("//", "window")) else json.loads(s)
    return obj


def boot(vals):
    rng = random.Random(SEED)
    means = sorted(statistics.fmean(rng.choice(vals) for _ in vals) for _ in range(B))
    return {"mean": round(statistics.fmean(vals), 4), "ci95": [round(means[int(0.025 * B)], 4), round(means[int(0.975 * B) - 1], 4)]}


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    R = load(sys.argv[1] if len(sys.argv) > 1 else root / "site" / "assets" / "study4_results.js")
    rows, fails, got = R["decisions"], [], {}
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if R.get("mode") != "LIVE":
        fails.append("the file is not marked LIVE")
    if digest != R.get("decisions_sha256"):
        fails.append("the decision rows do not match their recorded SHA-256 (the file was altered)")
    by = collections.defaultdict(list)
    for d in rows:
        by[d["condition"]].append(d)
    got["rows"], got["scenarios"] = len(rows), len({d["scenario"] for d in rows})
    got["decisions_matched"] = {k: (sum(d["outcome"] == "matched" for d in by[k]), len(by[k])) for k in ("direct", "delegated", "restored")}
    got["delegated_outcomes"] = {k: sum(d["outcome"] == k for d in by["delegated"]) for k in ("matched", "opposite", "unclear")}
    # a priority pair (unit) = the same scenario, option order and chain, with each of the two opposite priorities;
    # it is sensitive only if BOTH decisions matched their own priority
    units = collections.defaultdict(dict)
    for k in ("direct", "delegated", "restored"):
        for d in by[k]:
            units[k].setdefault((d["scenario"], d["order"], d["chain"] or 0), {})[d["case_id"].rsplit("_", 1)[1]] = d["outcome"]
    sens = {k: {u: v.get("p0") == "matched" and v.get("p1") == "matched" for u, v in units[k].items()} for k in units}
    got["paired_sensitive"] = {k: (sum(sens[k].values()), len(sens[k])) for k in ("direct", "delegated", "restored")}
    scen, chains = sorted({d["scenario"] for d in rows}), sorted({u[2] for u in sens["delegated"]})

    def per_scenario(a):            # per-scenario mean of (condition a - delegated) over orders and chains
        return [statistics.fmean(float(sens[a][(s, o, 0 if a == "direct" else c)]) - float(sens["delegated"][(s, o, c)])
                                 for o in ("orig", "swap") for c in chains) for s in scen]
    got["P1_direct_minus_delegated"] = boot(per_scenario("direct"))
    got["P2_restored_minus_delegated"] = boot(per_scenario("restored"))

    for k, want in PUBLISHED.items():
        ok = got[k] == want
        print("%-4s %-28s recomputed %s%s" % ("OK" if ok else "FAIL", k, json.dumps(got[k]), "" if ok else "   published " + json.dumps(want)))
        if not ok:
            fails.append(k)
    for f in fails:
        print("FAIL:", f)
    print("Study 4 headline numbers: %s" % ("REPRODUCED" if not fails else "NOT REPRODUCED"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
