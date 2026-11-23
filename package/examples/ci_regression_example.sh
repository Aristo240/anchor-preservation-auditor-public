#!/usr/bin/env bash
# Example CI regression check for the six-handoff `chain` test. Run from the priority_check_kit folder:
#     bash examples/ci_regression_example.sh
#
# As written it uses the built-in FAKE provider and compares against examples/ci_baseline_fake/, which was produced by
# an actual fake run. FAKE MODEL OUTPUT IS NOT EVIDENCE: this only shows the mechanics. For your own check, commit a
# baseline run directory made with your real provider and settings, and run the candidate with the SAME scenario,
# provider, model, settings, orders and --runs. A changed configuration is reported as CONFIGURATION CHANGE (exit 3,
# every difference listed); a different scenario, orders, fake-vs-real or an incomplete run is NOT A VALID CONTROLLED
# COMPARISON (exit 5).
#
# The rule below (--fail-on-drop delegated:0) is THE DEVELOPER'S OWN rule, chosen before looking at results; it is not
# a kit threshold and not a statistical test. With one run per case, a drop can be ordinary run-to-run variation.
#
# compare exit codes: 0 same configuration, no rule tripped | 3 configuration change, no rule tripped | 1 your rule
# tripped | 2 refused (bad input, records do not match their summary) | 5 not a valid controlled comparison.
set -u

PY="${PYTHON:-python}"
BASELINE="examples/ci_baseline_fake"
WORK="${CI_WORK_DIR:-$(mktemp -d)}"    # a new directory each time: `chain` never overwrites results
OUT="$WORK/candidate"

"$PY" -m priority_check chain --scenario examples/chain_scenario.example.json --provider fake --out "$OUT" || exit 2

"$PY" -m priority_check compare --baseline "$BASELINE" --candidate "$OUT" \
    --json "$WORK/comparison.json" \
    --fail-on-drop delegated:0
code=$?

case "$code" in
  0) echo "CI: same configuration; the developer's rule did not trip" ;;
  3) echo "CI: configuration change (every difference listed above); the developer's rule did not trip" ;;
  1) echo "CI: the developer's own rule tripped (see the counts above)" ;;
  5) echo "CI: not a valid controlled comparison; fix the listed reasons or record a new baseline on purpose" ;;
  *) echo "CI: compare refused the input (exit $code)" ;;
esac
exit "$code"
