"""The `chain` subcommand: python -m priority_check chain --scenario s.json --provider fake --out results/"""
import argparse
import json
import sys

from .chain import CALLS_PER_CASE, ORDERS, ScenarioError, execute, load_scenario, planned_calls

CHAIN_HELP = """Test the FIXED six-handoff workflow (advisor -> critic -> summarizer, twice; only handoff 1 gets the priority)
on your own two-option scenario. For each priority direction (A, B) and option order: one chain with the priority,
one chain without, then five decision calls (direct, delegated, restored, direct_no_priority, chain_no_priority):
%d calls per direction and order. The exact count is printed before anything runs.

Providers: 'fake' is a deterministic offline stand-in (its output is NOT evidence about any model).
'anthropic', 'openai', 'gemini', 'openrouter' are thin standard-library adapters that are UNTESTED AGAINST THE LIVE
SERVICES. They need --model (an exact pinned id; aliases such as 'latest' are refused), --api-key-env (the NAME of the environment
variable holding your key; it is read at send time and never written anywhere), --i-accept-costs, and --max-calls
equal to the planned count. The run stops (exit 4) if the server reports a different model than requested.
'openrouter' also needs --provider-slug (one endpoint, e.g. deepinfra/fp8; fallbacks are disabled) and --provider-name
(that endpoint's provider_name, e.g. DeepInfra); it stops (exit 4) if another provider or model served a call. Results
are labelled <model>@<provider-slug>.

Exit codes: 0 finished; 2 refused (invalid scenario or arguments, output directory not empty); 4 stopped early.""" % CALLS_PER_CASE


def add_chain_parser(sub):
    c = sub.add_parser("chain", help="test the fixed six-handoff workflow", description=CHAIN_HELP,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    c.add_argument("--scenario", required=True, help="two-option scenario JSON (see examples/chain_scenario.example.json)")
    c.add_argument("--provider", required=True, choices=("fake", "anthropic", "openai", "gemini", "openrouter"))
    c.add_argument("--out", required=True, help="a new or empty directory")
    c.add_argument("--orders", choices=("both", "as_given"), default="both")
    c.add_argument("--runs", type=int, default=1, help="complete repetitions of the design (default 1)")
    c.add_argument("--model", help="exact pinned model id (required for real providers)")
    c.add_argument("--api-key-env", help="NAME of the environment variable holding the API key (real providers)")
    c.add_argument("--i-accept-costs", action="store_true", help="required for real providers: the calls are billed to you")
    c.add_argument("--max-calls", type=int, help="must equal the planned call count (required for real providers)")
    c.add_argument("--max-tokens", type=int, default=16384, help="output token limit per call incl. reasoning, real providers (default 16384); "
                   "a truncated answer is recorded and never scored or passed on")
    o = c.add_argument_group("openrouter provider (see README section 8)")
    o.add_argument("--provider-slug", help="the ONE inference endpoint to use, as the endpoints API 'tag' (e.g. deepinfra/fp8)")
    o.add_argument("--provider-name", help="that endpoint's provider_name in the endpoints API (e.g. DeepInfra); checked on every response")
    o.add_argument("--quantization", help="also filter by this quantization (e.g. fp8, bf16)")
    o.add_argument("--reasoning-effort", help="send reasoning.effort (max|xhigh|high|medium|low|minimal|none); omitted by default")
    o.add_argument("--data-collection", choices=("deny", "allow"), default="deny",
                   help="provider.data_collection (default deny: only providers that do not collect prompts)")
    o.add_argument("--zdr", action="store_true", help="also require a Zero Data Retention endpoint (provider.zdr = true)")
    o.add_argument("--accept-served-model", action="append", default=[],
                   help="another exact id the response may report for the same model (e.g. its canonical_slug); repeatable")
    f = c.add_argument_group("fake provider")
    f.add_argument("--fake-drift-after", type=int, help="handoffs after this one (1..5) drop the recommendation")
    f.add_argument("--fake-drift-to", choices=("A", "B"), default="A")
    f.add_argument("--fake-decision", choices=("follow", "decline", "malform"), default="follow")
    return c


def _fmt(k):
    return " ".join("%s=%d" % (o[:3], v) for o, v in k.items() if v) or "-"


def _refuse(msg):
    print("refused: %s" % msg, file=sys.stderr)
    return 2


def main_chain(a, transport=None) -> int:
    if a.runs < 1:
        return _refuse("--runs must be at least 1")
    try:
        sc = load_scenario(a.scenario)
    except (ScenarioError, OSError) as e:
        return _refuse("scenario: %s" % e)
    import pathlib
    if pathlib.Path(a.out).exists() and (not pathlib.Path(a.out).is_dir() or any(pathlib.Path(a.out).iterdir())):
        return _refuse("--out %s exists and is not empty; results are never overwritten" % a.out)
    orders = ORDERS if a.orders == "both" else ("as_given",)
    n = planned_calls(a.runs, len(orders))
    print("planned calls: %d (%d run(s) x 2 priority directions x %d order(s) x %d calls: 2 chains of 6 handoffs + 5 decisions)"
          % (n, a.runs, len(orders), CALLS_PER_CASE))
    if a.max_calls is not None and a.max_calls != n:
        return _refuse("--max-calls %d does not equal the planned count %d" % (a.max_calls, n))
    if a.provider == "fake":
        from .providers import FakeChainProvider
        try:
            prov = FakeChainProvider(sc, drift_after=a.fake_drift_after, drift_to=a.fake_drift_to, decision_mode=a.fake_decision)
        except ValueError as e:
            return _refuse(str(e))
    else:
        if not a.i_accept_costs:
            return _refuse("real provider %r needs --i-accept-costs (the %d calls are billed to you)" % (a.provider, n))
        if a.max_calls is None:
            return _refuse("real provider needs --max-calls %d (the planned count)" % n)
        if not a.api_key_env:
            return _refuse("real provider needs --api-key-env NAME")
        from .providers import REAL_PROVIDERS, OpenRouterProvider, urllib_transport
        try:
            if a.provider == "openrouter":
                if not a.provider_slug or not a.provider_name:
                    return _refuse("openrouter needs --provider-slug and --provider-name (see the endpoints API)")
                prov = OpenRouterProvider(a.model, a.api_key_env, a.provider_slug, a.provider_name, max_tokens=a.max_tokens,
                                          reasoning_effort=a.reasoning_effort, quantization=a.quantization,
                                          data_collection=a.data_collection, zdr=a.zdr, accept_model_ids=tuple(a.accept_served_model),
                                          transport=transport or urllib_transport)
            else:
                if a.provider_slug or a.provider_name:
                    return _refuse("--provider-slug and --provider-name apply only to --provider openrouter")
                prov = REAL_PROVIDERS[a.provider](a.model, a.api_key_env, max_tokens=a.max_tokens, transport=transport or urllib_transport)
        except ValueError as e:
            return _refuse(str(e))
        print("provider %s, model %s (adapter UNTESTED against the live service)" % (a.provider, prov.model_requested))
    try:
        code, paths, s = execute(sc, prov, a.out, a.runs, orders, fake=a.provider == "fake")
    except FileExistsError as e:
        return _refuse(str(e))
    if a.provider == "fake":
        print("FAKE MODEL OUTPUT IS NOT EVIDENCE about any model (built-in fake provider):")
    for c, p in s["paired"].items():
        k = s["counts"][c]
        print("%-19s A: %-35s B: %-35s both priorities got their own option: %d of %d readable pair(s), %d case(s)" % (
            c, _fmt(k["A"]), _fmt(k["B"]), p["both_priorities_got_their_own_option"], p["readable_cases"], p["cases"]))
    print(json.dumps(paths, indent=1))
    if a.provider == "fake":
        print("note: fake model output is not evidence about any model")
    if code == 4:
        print("stopped early: %s" % s["incomplete"], file=sys.stderr)
    return code
