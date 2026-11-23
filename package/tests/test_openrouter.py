"""Offline tests for the OpenRouter provider. No network: socket connections raise during every test.
The provider is exercised ONLY through an injected fake transport; responses follow the documented shapes
(docs/openrouter_metadata_2026-11-17/docs_pages/)."""
import copy
import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from priority_check import chain as ch   # noqa: E402
from priority_check import __main__ as cli   # noqa: E402
from priority_check.providers import OpenRouterProvider, StopRun, check_openrouter_model   # noqa: E402

EXAMPLE = ROOT / "examples" / "chain_scenario.example.json"
SC = ch.load_scenario(EXAMPLE)
SECRET = "sk-or-TEST-SECRET-0123456789abcdef"
MODEL, SLUG, PNAME = "qwen/qwen3-235b-a22b-2507", "deepinfra/fp8", "DeepInfra"


def or_response(text="FIRST CHOICE: A\nok", model=MODEL, provider=PNAME, finish="stop", native="stop", reasoning="thinking...",
                metadata=True, top_provider=True):
    r = {"id": "gen-1700000000-abcDEF123", "object": "chat.completion", "created": 1700000000, "model": model,
         "system_fingerprint": None,
         "choices": [{"index": 0, "finish_reason": finish, "native_finish_reason": native,
                      "message": {"role": "assistant", "content": text, "reasoning": reasoning}}],
         "usage": {"prompt_tokens": 1500, "completion_tokens": 1200, "total_tokens": 2700,
                   "completion_tokens_details": {"reasoning_tokens": 400}, "cost": 0.00123, "is_byok": False}}
    if top_provider:
        r["provider"] = provider
    if metadata:
        r["openrouter_metadata"] = {"requested": model, "strategy": "direct", "region": "iad", "summary": "available=1",
                                    "attempt": 1, "is_byok": False,
                                    "endpoints": {"total": 1, "available": [{"model": model, "provider": provider, "selected": True}]}}
    return r


def fake_or_transport(log=None, **kw):
    def t(url, headers, body):
        if log is not None:
            log.append((url, headers, json.loads(body)))
        return or_response(**kw)
    return t


class Base(unittest.TestCase):
    def setUp(self):
        for target in ((socket.socket, "connect"),):
            p = mock.patch.object(*target, side_effect=AssertionError("network used"))
            p.start(); self.addCleanup(p.stop)
        p = mock.patch("socket.create_connection", side_effect=AssertionError("network used"))
        p.start(); self.addCleanup(p.stop)
        p = mock.patch.dict(os.environ, {"PCK_OR_KEY": SECRET})
        p.start(); self.addCleanup(p.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)

    def prov(self, transport, **kw):
        return OpenRouterProvider(MODEL, "PCK_OR_KEY", SLUG, PNAME, transport=transport, **kw)

    def cli(self, *args, transport=None):
        o, e = io.StringIO(), io.StringIO()
        with redirect_stdout(o), redirect_stderr(e), mock.patch("priority_check.providers.urllib_transport", transport):
            code = cli.main(list(args))
        return code, o.getvalue(), e.getvalue()

    def out(self):
        return os.path.join(self.tmp.name, "o")


class Request(Base):
    def test_request_body_pins_model_and_one_provider_with_no_fallbacks(self):
        log = []
        p = self.prov(fake_or_transport(log), reasoning_effort="medium", quantization="fp8")
        text, served = p.complete("hello")
        self.assertEqual((text, served), ("FIRST CHOICE: A\nok", MODEL + "@" + SLUG))
        url, headers, body = log[0]
        self.assertEqual(url, "https://openrouter.ai/api/v1/chat/completions")
        self.assertEqual(body["model"], MODEL)
        self.assertEqual(body["messages"], [{"role": "user", "content": "hello"}])
        self.assertEqual(body["max_tokens"], 16384)
        self.assertIs(body["stream"], False)
        self.assertEqual(body["reasoning"], {"effort": "medium"})
        self.assertEqual(body["provider"], {"order": [SLUG], "only": [SLUG], "allow_fallbacks": False, "require_parameters": True,
                                            "data_collection": "deny", "quantizations": ["fp8"]})
        for k in ("temperature", "top_p", "top_k", "seed", "frequency_penalty", "presence_penalty", "min_p", "models", "route"):
            self.assertNotIn(k, body)
        self.assertEqual(headers["X-OpenRouter-Metadata"], "enabled")
        self.assertEqual(headers["Authorization"], "Bearer " + SECRET)

    def test_defaults_omit_reasoning_and_quantization(self):
        log = []
        self.prov(fake_or_transport(log)).complete("x")
        body = log[0][2]
        self.assertNotIn("reasoning", body)
        self.assertNotIn("quantizations", body["provider"]); self.assertNotIn("zdr", body["provider"])
        log = []
        self.prov(fake_or_transport(log), zdr=True, data_collection="allow").complete("x")
        self.assertEqual(log[0][2]["provider"]["data_collection"], "allow"); self.assertIs(log[0][2]["provider"]["zdr"], True)

    def test_pinning_refuses_aliases_variants_and_routers(self):
        for bad in ("~deepseek/deepseek-pro-latest", "qwen/qwen3-235b-a22b-2507:nitro", "qwen/qwen3-235b-a22b-2507:free",
                    "openrouter/auto", "openrouter/free", "qwen-latest", "anthropic/claude-sonnet-latest", "Qwen/Qwen3", "qwen3", ""):
            with self.subTest(bad), self.assertRaises(ValueError):
                check_openrouter_model(bad)
        self.assertEqual(check_openrouter_model("meta-llama/llama-4-maverick"), "meta-llama/llama-4-maverick")
        for kw in ({"provider_slug": ""}, {"provider_slug": "DeepInfra"}, {"provider_name": ""}, {"reasoning_effort": "medium-ish"},
                   {"quantization": "q4"}, {"provider_slug": "deepinfra/fp4", "quantization": "fp8"}, {"data_collection": "maybe"}):
            with self.subTest(kw), self.assertRaises(ValueError):
                args = dict(model=MODEL, api_key_env="PCK_OR_KEY", provider_slug=SLUG, provider_name=PNAME)
                args.update(kw)
                OpenRouterProvider(transport=fake_or_transport(), **args)


class Verification(Base):
    def test_provider_mismatch_stops_and_is_recorded_raw(self):
        for kw in ({"provider": "Together"}, {"provider": "Together", "metadata": False}, {"metadata": False, "top_provider": False}):
            with self.subTest(kw):
                p = self.prov(fake_or_transport(**kw))
                with self.assertRaises(StopRun):
                    p.complete("x")
                self.assertIsNotNone(p.last_exchange["response"])   # the raw response is kept for the record

    def test_provider_mismatch_only_in_metadata_is_caught(self):
        def t(url, headers, body):
            r = or_response()
            r["openrouter_metadata"]["endpoints"]["available"][0]["provider"] = "Novita"
            return r
        with self.assertRaises(StopRun):
            self.prov(t).complete("x")

    def test_non_direct_routing_strategy_stops(self):
        def t(url, headers, body):
            r = or_response(); r["openrouter_metadata"]["strategy"] = "fallback"; return r
        with self.assertRaises(StopRun):
            self.prov(t).complete("x")

    def test_unrequested_service_tier_stops(self):
        def t(url, headers, body):
            r = or_response(); r["service_tier"] = "priority"; return r
        with self.assertRaises(StopRun):
            self.prov(t).complete("x")
        p = OpenRouterProvider(MODEL, "PCK_OR_KEY", "deepinfra/fp8/priority", PNAME, transport=t)
        self.assertEqual(p.complete("x")[1], MODEL + "@deepinfra/fp8/priority")   # the tier was pinned explicitly
        p = OpenRouterProvider(MODEL, "PCK_OR_KEY", "parasail/fast", PNAME, transport=t)
        self.assertEqual(p.complete("x")[1], MODEL + "@parasail/fast")   # 'fast' is the docs' alias for 'priority'

    def test_model_mismatch_stops(self):
        with self.assertRaises(StopRun):
            self.prov(fake_or_transport(model="qwen/qwen3-235b-a22b-thinking-2507")).complete("x")

        def t(url, headers, body):
            r = or_response(); r["choices"][0]["message"]["model"] = "qwen/other"; return r
        with self.assertRaises(StopRun):
            self.prov(t).complete("x")
        # an explicitly accepted exact id (e.g. the canonical slug) is allowed
        p = self.prov(fake_or_transport(model="qwen/qwen3-235b-a22b-07-25"), accept_model_ids=("qwen/qwen3-235b-a22b-07-25",))
        self.assertEqual(p.complete("x")[1], "qwen/qwen3-235b-a22b-07-25@" + SLUG)

    def test_provider_mismatch_in_a_cli_run_stops_with_exit_4(self):
        code, out, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "openrouter", "--model", MODEL,
                                  "--provider-slug", SLUG, "--provider-name", PNAME, "--api-key-env", "PCK_OR_KEY",
                                  "--i-accept-costs", "--max-calls", "68", "--out", self.out(),
                                  transport=fake_or_transport(provider="Together"))
        self.assertEqual(code, 4); self.assertIn("differs from pinned", err)
        recs = [json.loads(x) for x in pathlib.Path(self.out(), "records.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(recs), 1)
        self.assertIsNone(recs[0]["response_text"]); self.assertIsNone(recs[0]["model_served"])   # never stored under the label
        self.assertEqual(recs[0]["exchange"]["served_provider"], "Together")


class Completeness(Base):
    def test_truncation_error_and_empty_content_are_missing(self):
        cases = [dict(finish="length", native="length"), dict(finish="stop", native="max_tokens"),
                 dict(finish="stop", native="MAX_TOKENS"), dict(finish="content_filter", native="refusal"),
                 dict(finish="error", native=None), dict(finish=None, native=None), dict(text=None), dict(text="   "),
                 dict(text="", finish="length", native="length")]
        for kw in cases:
            with self.subTest(kw):
                p = self.prov(fake_or_transport(**kw))
                with self.assertRaises(RuntimeError) as cm:
                    p.complete("x")
                self.assertNotIsInstance(cm.exception, StopRun)
                self.assertIsNotNone(p.last_exchange["response"])

    def test_error_object_with_http_200_is_missing(self):
        bodies = [{"id": "gen-1", "error": {"code": 502, "message": "Provider returned error",
                                            "metadata": {"error_type": "provider_unavailable", "provider_name": PNAME}}},
                  dict(or_response(), choices=[dict(or_response()["choices"][0], finish_reason="error",
                                                    error={"code": 500, "message": "boom"})]),
                  {"id": "gen-2", "model": MODEL, "provider": PNAME, "choices": []}]
        for b in bodies:
            with self.subTest(b.get("id")):
                p = self.prov(lambda u, h, d, b=b: copy.deepcopy(b))
                with self.assertRaises(RuntimeError):
                    p.complete("x")

    def test_reasoning_is_not_the_answer_but_is_kept_raw(self):
        p = self.prov(fake_or_transport(text="FIRST CHOICE: B\nfine", reasoning="SECRET CHAIN OF THOUGHT"))
        text, _ = p.complete("x")
        self.assertNotIn("SECRET CHAIN OF THOUGHT", text)
        self.assertEqual(p.last_exchange["response"]["choices"][0]["message"]["reasoning"], "SECRET CHAIN OF THOUGHT")
        with self.assertRaises(RuntimeError):   # reasoning only, no content: not an answer
            self.prov(fake_or_transport(text=None, reasoning="only thinking", finish="length", native="length")).complete("x")

    def test_content_parts_array_is_joined(self):
        p = self.prov(fake_or_transport(text=[{"type": "text", "text": "FIRST CHOICE: A"}, {"type": "text", "text": "\nok"}]))
        self.assertEqual(p.complete("x")[0], "FIRST CHOICE: A\nok")


class Records(Base):
    def test_full_six_handoff_chain_via_fake_transport_records_and_no_key(self):
        calls = []

        def t(url, headers, body):
            calls.append(json.loads(body))
            return or_response(text="FIRST CHOICE: B\nfine")
        code, out, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "openrouter", "--model", MODEL,
                                  "--provider-slug", SLUG, "--provider-name", PNAME, "--quantization", "fp8",
                                  "--reasoning-effort", "medium", "--api-key-env", "PCK_OR_KEY",
                                  "--i-accept-costs", "--max-calls", "68", "--out", self.out(), transport=t)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(calls), 68)
        self.assertIn(MODEL + "@" + SLUG, out)
        recs = [json.loads(x) for x in pathlib.Path(self.out(), "records.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(recs), 68)
        hand = [r for r in recs if r["kind"] == "handoff"]
        self.assertEqual(len(hand), 2 * 2 * 2 * 6)
        self.assertEqual({r["outcome"] for r in hand}, {"OK"})
        for r in recs:
            self.assertEqual(r["provider"], "openrouter")
            self.assertEqual(r["model_requested"], MODEL + "@" + SLUG)
            self.assertEqual(r["model_served"], MODEL + "@" + SLUG)
            ex = r["exchange"]
            self.assertEqual(ex["request_body"]["messages"][0]["content"], r["prompt"])
            self.assertEqual(ex["request_body"]["provider"]["only"], [SLUG])
            self.assertEqual(ex["generation_id"], "gen-1700000000-abcDEF123")
            self.assertEqual((ex["served_model"], ex["served_provider"]), (MODEL, PNAME))
            self.assertEqual(ex["usage"]["completion_tokens"], 1200); self.assertEqual(ex["cost"], 0.00123)
            self.assertEqual(ex["finish"], "stop"); self.assertEqual(ex["native_finish"], "stop")
            self.assertEqual(ex["header_names"], ["Authorization", "Content-Type", "X-OpenRouter-Metadata"])
            self.assertEqual(ex["response"]["choices"][0]["message"]["reasoning"], "thinking...")
            self.assertNotIn("thinking...", r["response_text"])
        s = json.loads(pathlib.Path(self.out(), "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(s["models_served"], [MODEL + "@" + SLUG])
        self.assertNotIn(SECRET, out + err)
        for f in pathlib.Path(self.out()).iterdir():
            self.assertNotIn(SECRET, f.read_text(encoding="utf-8"), f.name)

    def test_key_not_kept_on_the_object_and_not_in_exchange(self):
        p = self.prov(fake_or_transport())
        p.complete("x")
        self.assertNotIn(SECRET, json.dumps(vars(p), default=repr))
        self.assertNotIn(SECRET, json.dumps(p.last_exchange))

    def test_cli_gates_for_openrouter(self):
        never = mock.Mock(side_effect=AssertionError("transport must not be called"))
        base = ("chain", "--scenario", str(EXAMPLE), "--provider", "openrouter", "--model", MODEL, "--api-key-env", "PCK_OR_KEY",
                "--i-accept-costs", "--max-calls", "68")
        for extra, msg in ((("--provider-name", PNAME), "--provider-slug"), (("--provider-slug", SLUG), "--provider-name"),
                           (("--provider-slug", SLUG, "--provider-name", PNAME, "--reasoning-effort", "lots"), "reasoning-effort")):
            with self.subTest(extra):
                code, _, err = self.cli(*(base + extra + ("--out", self.out())), transport=never)
                self.assertEqual(code, 2); self.assertIn(msg, err); self.assertFalse(os.path.exists(self.out()))
        code, _, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "openrouter", "--model", "openrouter/auto",
                                "--provider-slug", SLUG, "--provider-name", PNAME, "--api-key-env", "K", "--i-accept-costs",
                                "--max-calls", "68", "--out", self.out(), transport=never)
        self.assertEqual(code, 2)
        code, _, err = self.cli("chain", "--scenario", str(EXAMPLE), "--provider", "anthropic", "--model", "claude-test-20990101",
                                "--provider-slug", SLUG, "--api-key-env", "K", "--i-accept-costs", "--max-calls", "68",
                                "--out", self.out(), transport=never)
        self.assertEqual(code, 2); self.assertIn("only to --provider openrouter", err)
        never.assert_not_called()


class GenerationStats(Base):
    def test_fetch_generation_stats_via_fake_get_transport(self):
        seen = []

        def g(url, headers):
            seen.append((url, headers))
            return {"data": {"id": "gen-1700000000-abcDEF123", "model": MODEL, "provider_name": PNAME, "total_cost": 0.00123,
                             "native_finish_reason": "stop", "provider_responses": None}}
        p = OpenRouterProvider(MODEL, "PCK_OR_KEY", SLUG, PNAME, transport=fake_or_transport(), get_transport=g)
        r = p.fetch_generation_stats("gen-1700000000-abcDEF123")
        self.assertTrue(r["provider_name_matches"]); self.assertTrue(r["model_matches"])
        self.assertEqual(seen[0][0], "https://openrouter.ai/api/v1/generation?id=gen-1700000000-abcDEF123")
        self.assertNotIn(SECRET, json.dumps(r))
        with self.assertRaises(ValueError):
            p.fetch_generation_stats("gen-1&x=y")


if __name__ == "__main__":
    unittest.main()
