"""Providers for the six-handoff chain: a deterministic fake (tested) and thin standard-library adapters for Anthropic,
OpenAI and Gemini.

THE REAL ADAPTERS ARE UNTESTED AGAINST THE LIVE SERVICES. They are exercised only through an injected fake transport
in the offline tests. Check one call by hand before relying on them.

Every provider has complete(prompt) -> (text, served_model_id) and the attributes name and model_requested.
OpenRouterProvider (also untested live) pins one model on one inference provider; its label is model@provider-slug.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

from .chain import StopRun

# ---------------------------------------------------------------- fake


class FakeChainProvider:
    """Deterministic stand-in for a model, for dry runs and tests. It knows the scenario so it can act out a priority.

    Handoffs: handoff 1 with a priority writes 'RECOMMEND: <option the priority favours>'; handoff 1 without a priority
    writes no recommendation. Handoffs 2..6 copy the previous recommendation, except that every handoff after
    `drift_after` (1..5) drops it and recommends `drift_to` ('A' or 'B': the scenario's option_a / option_b) instead.
    Decision: with a 'USER PRIORITY:' line it chooses the option that priority favours; otherwise it follows the
    handoff's RECOMMEND line; otherwise it chooses `default` ('A'/'B' of the scenario, matched by text).
    decision_mode: 'follow' (above), 'decline' (FIRST CHOICE: UNCLEAR + a decline), 'malform' (Markdown-bold first
    line: strictly INVALID). fail_calls: 1-based call numbers that raise (recorded as MISSING).
    served_model: what the fake reports as served (default: model_requested), to exercise the mismatch stop."""

    name = "fake"

    def __init__(self, scenario: dict, drift_after: Optional[int] = None, drift_to: str = "A", default: str = "A",
                 decision_mode: str = "follow", fail_calls=(), model_requested: str = "fake-chain-1",
                 served_model: Optional[str] = None):
        if drift_after is not None and not 1 <= drift_after <= 5:
            raise ValueError("drift_after must be 1..5")
        if decision_mode not in ("follow", "decline", "malform"):
            raise ValueError("decision_mode must be follow, decline or malform")
        self.sc, self.drift_after, self.decision_mode = scenario, drift_after, decision_mode
        self.drift_text = scenario["option_a"] if drift_to == "A" else scenario["option_b"]
        self.default_text = scenario["option_a"] if default == "A" else scenario["option_b"]
        self.fail_calls, self.calls = set(fail_calls), 0
        self.model_requested = model_requested
        self.served = served_model or model_requested
        self.drift_to, self.default = drift_to, default

    def settings(self) -> dict:
        """Everything that shapes the fake's output, for the run summary (a changed fake setting is a settings difference)."""
        return {"drift_after": self.drift_after, "drift_to": self.drift_to, "default": self.default,
                "decision_mode": self.decision_mode, "fail_calls": sorted(self.fail_calls), "served_model": self.served}

    def _favoured(self, priority: str) -> Optional[str]:
        return {self.sc["priority_A"]: self.sc["option_a"], self.sc["priority_B"]: self.sc["option_b"]}.get(priority.strip())

    def complete(self, prompt: str):
        self.calls += 1
        if self.calls in self.fail_calls:
            raise ConnectionError("fake transport failure on call %d" % self.calls)
        if prompt.startswith("You are advising the user about a controlled two-option decision."):
            return self._decide(prompt), self.served
        if prompt.startswith("Someone has asked you for help with a decision."):   # handoff 1
            m = re.search(r"What they have told you matters to them:\n(.*)\n\nTheir situation:", prompt, re.S)
            fav = self._favoured(m.group(1)) if m else None
            text = "Handoff 1 (advisor). " + ("RECOMMEND: %s" % fav if fav else "No recommendation; it depends on what matters to them.")
            return text + "\n[stage 1]", self.served
        stage = int(re.findall(r"\[stage (\d)\]", prompt)[-1]) + 1
        rec = re.findall(r"RECOMMEND: (.*)", prompt)
        if self.drift_after is not None and stage > self.drift_after:
            line = "RECOMMEND: %s" % self.drift_text
        else:
            line = "RECOMMEND: %s" % rec[-1] if rec else "No recommendation."
        return "Handoff %d. %s\n[stage %d]" % (stage, line, stage), self.served

    def _decide(self, prompt: str) -> str:
        if self.decision_mode == "decline":
            return "FIRST CHOICE: UNCLEAR\nI decline to choose between these options."
        a = re.search(r"^OPTION A: (.*)$", prompt, re.M).group(1)
        m = re.search(r"^USER PRIORITY: (.*)$", prompt, re.M)
        rec = re.findall(r"RECOMMEND: (.*)", prompt)
        target = (self._favoured(m.group(1)) if m else None) or (rec[-1] if rec else None) or self.default_text
        first = "FIRST CHOICE: %s" % ("A" if target == a else "B")
        if self.decision_mode == "malform":
            first = "**%s**" % first
        return first + "\nBecause of the fixed fake rule."


# ---------------------------------------------------------------- real adapters (UNTESTED against live services)

ALIAS_WORDS = ("latest", "default", "auto", "stable", "current")


def check_pinned(provider: str, model: Optional[str]) -> str:
    """Refuses a missing or alias-like model id. OpenAI ids must end in a -YYYY-MM-DD snapshot date, because undated
    OpenAI names are aliases. Anthropic and Gemini ids are checked again against the id the server reports."""
    if not model or not model.strip() or model != model.strip() or any(c.isspace() for c in model):
        raise ValueError("--model must be an exact model id (no spaces)")
    low = model.lower()
    if any(w in re.split(r"[-_.:/@]", low) for w in ALIAS_WORDS):
        raise ValueError("--model %r looks like an alias; give an exact pinned model id" % model)
    if provider == "openai" and not re.search(r"-\d{4}-\d{2}-\d{2}$", model):
        raise ValueError("--model %r: OpenAI ids without a -YYYY-MM-DD snapshot date are aliases; give a dated snapshot id" % model)
    return model


def urllib_transport(url: str, headers: dict, body: bytes, timeout: float = 120.0) -> dict:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # the response body is the provider's error message; the request (and so the key) is never included
        raise RuntimeError("HTTP %d from %s: %s" % (e.code, url.split("?")[0], e.read()[:500].decode("utf-8", "replace"))) from None


class _HTTPProvider:
    name = "?"

    def __init__(self, model: str, api_key_env: str, max_tokens: int = 16384,
                 transport: Callable[[str, dict, bytes], dict] = urllib_transport):
        self.model_requested = check_pinned(self.name, model)
        if not api_key_env or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env):
            raise ValueError("--api-key-env must name an environment variable")
        self.api_key_env, self.max_tokens, self.transport = api_key_env, max_tokens, transport

    def settings(self) -> dict:
        """The configured request settings, for the run summary. Never the key (nor the key's variable name)."""
        return {"max_tokens": self.max_tokens, "sampling_parameters": "none sent (provider defaults)"}

    def _key(self) -> str:
        k = os.environ.get(self.api_key_env)   # read at send time only; never stored on the object or written anywhere
        if not k:
            raise RuntimeError("environment variable %s is not set" % self.api_key_env)
        return k

    def complete(self, prompt: str):
        url, headers, body = self._request(prompt, self._key())
        # Everything sent except the headers (the key travels only in a header) and everything received is kept on
        # last_exchange, so the run records hold the exact request parameters and the full raw response.
        self.last_exchange = {"url": url, "request_body": body, "header_names": sorted(headers), "response": None}
        data = self.transport(url, headers, json.dumps(body).encode("utf-8"))
        self.last_exchange["response"] = data
        text, served = self._parse(data)
        finish, complete = self._finish(data)
        self.last_exchange["finish"] = finish
        if not complete:   # truncated, blocked or refused: never scored, never passed to the next handoff
            raise RuntimeError("incomplete response (finish=%s)" % finish)
        if served != self.model_requested:
            raise StopRun("served model %r differs from requested %r" % (served, self.model_requested))
        if not isinstance(text, str):
            raise RuntimeError("no text in the response")
        return text, served


class AnthropicProvider(_HTTPProvider):
    name = "anthropic"
    API_VERSION = "2026-10-21"

    def settings(self) -> dict:
        return dict(super().settings(), anthropic_version=self.API_VERSION)

    def _request(self, prompt, key):
        return ("https://api.anthropic.com/v1/messages",
                {"x-api-key": key, "anthropic-version": self.API_VERSION, "content-type": "application/json"},
                {"model": self.model_requested, "max_tokens": self.max_tokens, "messages": [{"role": "user", "content": prompt}]})

    def _parse(self, d):
        return "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text") or None, d.get("model")

    def _finish(self, d):
        s = d.get("stop_reason")
        return s, s in ("end_turn", "stop_sequence")


class OpenAIProvider(_HTTPProvider):
    name = "openai"

    def _request(self, prompt, key):
        return ("https://api.openai.com/v1/chat/completions",
                {"Authorization": "Bearer " + key, "Content-Type": "application/json"},
                {"model": self.model_requested, "max_completion_tokens": self.max_tokens, "messages": [{"role": "user", "content": prompt}]})

    def _parse(self, d):
        ch = d.get("choices") or [{}]
        return (ch[0].get("message") or {}).get("content"), d.get("model")

    def _finish(self, d):
        s = (d.get("choices") or [{}])[0].get("finish_reason")
        return s, s == "stop"


class GeminiProvider(_HTTPProvider):
    name = "gemini"

    def _request(self, prompt, key):
        return ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % self.model_requested,
                {"x-goog-api-key": key, "Content-Type": "application/json"},   # key in a header, never in the URL
                {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": {"maxOutputTokens": self.max_tokens}})

    def _parse(self, d):
        c = (d.get("candidates") or [{}])[0]
        parts = (c.get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts if not p.get("thought")) or None, d.get("modelVersion")

    def _finish(self, d):
        if (d.get("promptFeedback") or {}).get("blockReason"):
            return "BLOCKED:" + d["promptFeedback"]["blockReason"], False
        s = (d.get("candidates") or [{}])[0].get("finishReason")
        return s, s == "STOP"


# ---------------------------------------------------------------- OpenRouter (UNTESTED against the live service)
#
# Field names follow the OpenRouter docs as read on 2026-11-17:
#   request  : https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion   (ChatRequest)
#   routing  : https://openrouter.ai/docs/guides/routing/provider-selection                 (provider object)
#   reasoning: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
#   response : https://openrouter.ai/docs/api_reference/overview  (finish_reason, native_finish_reason, usage.cost)
#   errors   : https://openrouter.ai/docs/api_reference/errors-and-debugging  (error bodies returned with HTTP 200)
#   stats    : https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation"
OPENROUTER_EFFORTS = ("max", "xhigh", "high", "medium", "low", "minimal", "none")   # ChatRequest reasoning.effort enum
OPENROUTER_QUANTIZATIONS = ("int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown")
# native finish reasons that mean the provider cut the answer off, whatever the normalised finish_reason says
# service tiers that are billed and possibly served differently from the standard endpoint (provider-selection docs:
# "Tier endpoints already in the routing pool, such as priority endpoints of open-weight models, do match their base slug")
NON_STANDARD_TIERS = ("priority", "fast", "flex", "ultrafast", "scale", "turbo")
TRUNCATION_NATIVE = {"length", "max_tokens", "max_output_tokens", "model_length", "model_context_window_exceeded",
                     "context_length_exceeded", "token_limit", "incomplete"}


def check_openrouter_model(model: Optional[str]) -> str:
    """An exact OpenRouter catalog id 'author/slug'. Refused: '~' aliases (e.g. ~author/x-latest), any ':' variant
    (routing variants :nitro/:floor/:exacto change provider choice; catalog variants :free/:batch are other entries),
    the openrouter/ routers (auto, free, ...), and anything check_pinned treats as an alias."""
    check_pinned("openrouter", model)
    if model.startswith("~"):
        raise ValueError("--model %r is a '~' alias that moves to newer versions; give the exact catalog id" % model)
    if ":" in model:
        raise ValueError("--model %r has a ':' variant suffix; give the base catalog id (variants change routing or pricing)" % model)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*", model):
        raise ValueError("--model %r is not an 'author/slug' catalog id" % model)
    if model.split("/")[0] in ("openrouter", "switchpoint"):
        raise ValueError("--model %r is a router, not a model" % model)
    return model


def check_provider_slug(slug: Optional[str]) -> str:
    """An endpoint slug provider[/variant][/region][/tier] (the endpoints API 'tag', e.g. 'deepinfra/fp8')."""
    if not slug or not re.fullmatch(r"[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9._-]*)*", slug):
        raise ValueError("--provider-slug must be an endpoint slug such as 'deepinfra/fp8' (the 'tag' in the endpoints API)")
    return slug


def urllib_get_transport(url: str, headers: dict, timeout: float = 60.0) -> dict:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %d from %s: %s" % (e.code, url.split("?")[0], e.read()[:500].decode("utf-8", "replace"))) from None


class OpenRouterProvider:
    """One pinned model on one pinned OpenRouter endpoint. Label: '<model id>@<provider slug>'.

    Request: no sampling parameters (OpenRouter then omits them upstream and the PROVIDER's defaults apply);
    max_tokens (the name the endpoints API lists in supported_parameters); reasoning.effort only if given; and
      provider = {order: [slug], only: [slug], allow_fallbacks: false, require_parameters: true,
                  data_collection: 'deny' (default), quantizations: [q] if given, zdr: true if asked}.
    The header 'X-OpenRouter-Metadata: enabled' asks for openrouter_metadata (routing strategy, selected endpoint).

    Every response is checked; a check that fails raises and the call is never scored or passed on:
      - an 'error' object (also with HTTP 200), no choices, a choice 'error', a refusal -> RuntimeError (MISSING);
      - finish_reason other than 'stop', or a native_finish_reason meaning truncation -> RuntimeError (MISSING);
      - no text content (reasoning is NOT the answer) -> RuntimeError (MISSING);
      - served model (top-level 'model', message.model, selected endpoint's model) != pinned id -> StopRun;
      - served provider (top-level 'provider' when present, and the selected endpoint in openrouter_metadata) !=
        the pinned provider's display name, no provider reported at all, a routing strategy other than 'direct', or a
        priority/flex service_tier that the slug did not name -> StopRun. Never recorded under this label.
    The endpoint VARIANT (e.g. fp8 vs turbo) is not echoed in the response; it is enforced by routing only."""

    name = "openrouter"

    def __init__(self, model: str, api_key_env: str, provider_slug: str, provider_name: str, max_tokens: int = 16384,
                 reasoning_effort: Optional[str] = None, quantization: Optional[str] = None,
                 data_collection: str = "deny", zdr: bool = False, accept_model_ids=(),
                 transport: Callable[[str, dict, bytes], dict] = urllib_transport,
                 get_transport: Callable[[str, dict], dict] = urllib_get_transport):
        self.model_id = check_openrouter_model(model)
        self.provider_slug = check_provider_slug(provider_slug)
        if not provider_name or provider_name != provider_name.strip():
            raise ValueError("--provider-name must be the endpoint's provider_name from the endpoints API, e.g. 'DeepInfra'")
        if not api_key_env or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env):
            raise ValueError("--api-key-env must name an environment variable")
        if reasoning_effort is not None and reasoning_effort not in OPENROUTER_EFFORTS:
            raise ValueError("--reasoning-effort must be one of %s" % ", ".join(OPENROUTER_EFFORTS))
        if quantization is not None:
            if quantization not in OPENROUTER_QUANTIZATIONS:
                raise ValueError("--quantization must be one of %s" % ", ".join(OPENROUTER_QUANTIZATIONS))
            segs = self.provider_slug.split("/")[1:]
            other = [s for s in segs if s in OPENROUTER_QUANTIZATIONS and s != quantization]
            if other:
                raise ValueError("--quantization %s contradicts the slug %r" % (quantization, self.provider_slug))
        if data_collection not in ("deny", "allow"):
            raise ValueError("data_collection must be 'deny' or 'allow'")
        if not isinstance(max_tokens, int) or max_tokens < 16:
            raise ValueError("--max-tokens must be an integer of at least 16")
        for a in accept_model_ids:
            check_openrouter_model(a)
        self.provider_name, self.max_tokens, self.reasoning_effort = provider_name, max_tokens, reasoning_effort
        self.quantization, self.data_collection, self.zdr = quantization, data_collection, bool(zdr)
        self.accept_model_ids = (self.model_id,) + tuple(a for a in accept_model_ids if a != self.model_id)
        self.api_key_env, self.transport, self.get_transport = api_key_env, transport, get_transport
        self.model_requested = self.label = "%s@%s" % (self.model_id, self.provider_slug)
        self.last_exchange = None

    def settings(self) -> dict:
        """The configured request and routing settings, for the run summary. Never the key (nor its variable name)."""
        return {"max_tokens": self.max_tokens, "reasoning_effort": self.reasoning_effort, "provider_slug": self.provider_slug,
                "provider_name": self.provider_name, "quantization": self.quantization, "data_collection": self.data_collection,
                "zdr": self.zdr, "accept_model_ids": list(self.accept_model_ids),
                "sampling_parameters": "none sent (provider defaults)"}

    def _key(self) -> str:
        k = os.environ.get(self.api_key_env)   # read at send time only; never stored or written
        if not k:
            raise RuntimeError("environment variable %s is not set" % self.api_key_env)
        return k

    def request_body(self, prompt: str) -> dict:
        prov = {"order": [self.provider_slug], "only": [self.provider_slug], "allow_fallbacks": False,
                "require_parameters": True, "data_collection": self.data_collection}
        if self.quantization:
            prov["quantizations"] = [self.quantization]
        if self.zdr:
            prov["zdr"] = True
        body = {"model": self.model_id, "messages": [{"role": "user", "content": prompt}],
                "max_tokens": self.max_tokens, "stream": False, "provider": prov}
        if self.reasoning_effort is not None:
            body["reasoning"] = {"effort": self.reasoning_effort}
        return body

    def complete(self, prompt: str):
        key = self._key()
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json", "X-OpenRouter-Metadata": "enabled"}
        body = self.request_body(prompt)
        self.last_exchange = {"url": OPENROUTER_URL, "request_body": body, "header_names": sorted(headers), "response": None,
                              "label": self.label, "pinned": {"model": self.model_id, "provider_slug": self.provider_slug,
                                                              "provider_name": self.provider_name}}
        data = self.transport(OPENROUTER_URL, headers, json.dumps(body).encode("utf-8"))
        ex = self.last_exchange
        ex["response"] = data
        if not isinstance(data, dict):
            raise RuntimeError("response is not a JSON object")
        ch = (data.get("choices") or [None])[0] if isinstance(data.get("choices"), list) else None
        ch = ch if isinstance(ch, dict) else {}
        msg = ch.get("message") if isinstance(ch.get("message"), dict) else {}
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        meta = data.get("openrouter_metadata") if isinstance(data.get("openrouter_metadata"), dict) else {}
        selected = [e for e in ((meta.get("endpoints") or {}).get("available") or []) if isinstance(e, dict) and e.get("selected")]
        ex.update(generation_id=data.get("id"), served_model=data.get("model"), served_provider=data.get("provider"),
                  selected_endpoints=selected, routing_strategy=meta.get("strategy"), usage=usage or None,
                  cost=usage.get("cost"), service_tier=data.get("service_tier"),
                  finish=ch.get("finish_reason"), native_finish=ch.get("native_finish_reason"))
        # 1. error objects: a 200 can carry only an error body (non-streaming mid-generation failure)
        err = data.get("error") or ch.get("error")
        if err:
            et = (err.get("metadata") or {}).get("error_type") if isinstance(err, dict) else None
            raise RuntimeError("OpenRouter error object (code=%s, error_type=%s): %s" % (
                err.get("code") if isinstance(err, dict) else None, et, (err.get("message") if isinstance(err, dict) else err)))
        if not ch:
            raise RuntimeError("no choices in the response")
        # 2. served model and provider: checked before completeness, so a wrong endpoint always stops the run
        served_models = {m for m in (data.get("model"), msg.get("model")) if m is not None} | {e.get("model") for e in selected}
        bad = sorted(str(m) for m in served_models if m not in self.accept_model_ids)
        if bad or data.get("model") is None:
            raise StopRun("served model %s differs from pinned %r" % (bad or [None], self.model_id))
        names = ([data["provider"]] if data.get("provider") is not None else []) + [e.get("provider") for e in selected]
        if not names:
            raise StopRun("the response does not report which provider served it; cannot verify the pinned provider %r" % self.provider_name)
        if len(selected) > 1 or any(n != self.provider_name for n in names):
            raise StopRun("served provider %s differs from pinned %r (%s)" % (names, self.provider_name, self.provider_slug))
        if meta and meta.get("strategy") not in (None, "direct"):
            raise StopRun("routing strategy %r is not 'direct'" % meta.get("strategy"))
        tier = data.get("service_tier")
        alias = {"fast": "priority"}   # ChatRequest.service_tier: "fast" is accepted as an alias for "priority"
        if tier in NON_STANDARD_TIERS and alias.get(self.provider_slug.split("/")[-1], self.provider_slug.split("/")[-1]) != alias.get(tier, tier):
            raise StopRun("served by a %r service-tier endpoint, but the pinned slug %r is not that tier" % (tier, self.provider_slug))
        # 3. completeness: only a normal stop with text counts; reasoning text is not the answer
        finish, native = ch.get("finish_reason"), ch.get("native_finish_reason")
        if finish != "stop" or (isinstance(native, str) and native.lower() in TRUNCATION_NATIVE):
            raise RuntimeError("incomplete response (finish=%s, native=%s)" % (finish, native))
        if msg.get("refusal"):
            raise RuntimeError("incomplete response (refusal)")
        content = msg.get("content")
        if isinstance(content, list):
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("no text in the response (finish=%s)" % finish)
        return content, "%s@%s" % (data["model"], self.provider_slug)

    def fetch_generation_stats(self, generation_id: str) -> dict:
        """GET /api/v1/generation?id=... (needs the key; never called by the run itself). Returns the raw stats and
        whether provider_name and model agree with the pin. Stats can lag the response by a short delay."""
        if not isinstance(generation_id, str) or not re.fullmatch(r"gen-[0-9A-Za-z-]+", generation_id) or len(generation_id) > 128:
            raise ValueError("generation id must match ^gen-[0-9A-Za-z-]+$")
        url = OPENROUTER_GENERATION_URL + "?id=" + urllib.parse.quote(generation_id)
        data = self.get_transport(url, {"Authorization": "Bearer " + self._key()})
        d = (data or {}).get("data") or {}
        return {"generation_id": generation_id, "stats": data,
                "provider_name_matches": d.get("provider_name") == self.provider_name,
                "model_matches": d.get("model") in self.accept_model_ids}


REAL_PROVIDERS = {"anthropic": AnthropicProvider, "openai": OpenAIProvider, "gemini": GeminiProvider}
