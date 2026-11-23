"""Call budget for workflows you control: every model call made INSIDE the workflow is bounded and recorded.

The kit counts workflow executions; it cannot see or limit the model calls an arbitrary external workflow makes. For a
workflow you control, wrap its model client here, so that:

- before each attempt, the ledger reserves the attempt's WORST-CASE cost (input estimated from the request text at a
  conservative characters-per-token rate, plus the full output-token limit) and refuses the attempt if the call cap or
  the dollar cap would be exceeded. Refusal raises StopRun, which stops the kit's run (exit 4) with everything so far
  recorded;
- after each attempt, the actual usage (from the provider's usage fields when the client reports them, otherwise the
  estimate) and its cost are appended to a JSONL ledger, flushed and fsynced;
- an attempt that fails without a usable response is charged its reserved worst case (it may have been billed);
- retries are attempts like any other: they count against the same caps and are recorded;
- the ledger file is cumulative: several kit invocations (one per dilemma) share it, so the caps apply to the study
  as a whole, and a restart cannot reset them.

This guarantees the bound only for calls that go through `BudgetedModel`. Code that calls a model some other way is
not covered, and nothing here can bound a workflow whose calls you don't route through it.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
from typing import List, Optional

from priority_check.chain import StopRun


class BudgetExceeded(StopRun):
    pass


class Ledger:
    def __init__(self, path, max_calls: int, max_cost_usd: float, input_usd_per_1m: float, output_usd_per_1m: float,
                 max_output_tokens: int, chars_per_token: float = 2.0, overhead_tokens: int = 100):
        if max_calls < 1 or max_cost_usd <= 0 or input_usd_per_1m < 0 or output_usd_per_1m < 0 or max_output_tokens < 1 or chars_per_token <= 0:
            raise ValueError("invalid budget settings")
        self.path = pathlib.Path(path)
        self.max_calls, self.max_cost = int(max_calls), float(max_cost_usd)
        self.pin, self.pout = input_usd_per_1m / 1e6, output_usd_per_1m / 1e6
        self.max_out, self.cpt, self.overhead = int(max_output_tokens), float(chars_per_token), int(overhead_tokens)
        self.calls, self.charged = 0, 0.0
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    e = json.loads(line)
                    self.calls += 1
                    self.charged += float(e["charged_usd"])

    def settings(self) -> dict:
        return {"max_calls": self.max_calls, "max_cost_usd": self.max_cost, "input_usd_per_1m": self.pin * 1e6,
                "output_usd_per_1m": self.pout * 1e6, "max_output_tokens": self.max_out, "chars_per_token": self.cpt,
                "overhead_tokens": self.overhead}

    def worst_case(self, messages: List[dict]) -> float:
        chars = sum(len(m.get("content") or "") for m in messages)
        return (chars / self.cpt + self.overhead) * self.pin + self.max_out * self.pout

    def reserve(self, messages: List[dict]) -> float:
        w = self.worst_case(messages)
        if self.calls + 1 > self.max_calls:
            raise BudgetExceeded("call cap reached: %d of %d attempts used" % (self.calls, self.max_calls))
        if self.charged + w > self.max_cost:
            raise BudgetExceeded("dollar cap: $%.4f charged + $%.4f worst case for the next attempt > cap $%.2f" % (self.charged, w, self.max_cost))
        return w

    def record(self, entry: dict) -> None:
        self.calls += 1
        self.charged += float(entry["charged_usd"])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n"); f.flush(); os.fsync(f.fileno())

    def cost(self, usage: dict) -> float:
        return usage.get("input_tokens", 0) * self.pin + usage.get("output_tokens", 0) * self.pout


class BudgetedModel:
    """Wraps a client with .invoke(messages) -> str and .model_id. If the client sets .last_usage =
    {"input_tokens", "output_tokens"} after a call, that usage is charged; otherwise the conservative estimate is."""
    TRANSIENT = (TimeoutError, ConnectionError)

    def __init__(self, inner, ledger: Ledger, execution_id: str, max_attempts: int = 2, agent: Optional[str] = None):
        self.inner, self.ledger, self.execution_id, self.max_attempts, self.agent = inner, ledger, execution_id, max_attempts, agent
        self.model_id = inner.model_id
        self.last_usage = None

    def for_agent(self, agent: str) -> "BudgetedModel":
        return BudgetedModel(self.inner, self.ledger, self.execution_id, self.max_attempts, agent)

    def invoke(self, messages: List[dict]) -> str:
        last = None
        for attempt in range(1, self.max_attempts + 1):
            reserved = self.ledger.reserve(messages)              # raises BudgetExceeded before any call
            entry = {"time": _dt.datetime.now(_dt.timezone.utc).isoformat(), "execution_id": self.execution_id, "agent": self.agent,
                     "model": self.model_id, "attempt": attempt, "reserved_usd": round(reserved, 8)}
            try:
                text = self.inner.invoke(messages)
            except self.TRANSIENT as e:
                entry.update(status="transient error, no usable response: %s" % type(e).__name__, usage=None, charged_usd=round(reserved, 8))
                self.ledger.record(entry)
                last = e
                continue
            except Exception as e:
                entry.update(status="error: %s" % type(e).__name__, usage=None, charged_usd=round(reserved, 8))
                self.ledger.record(entry)
                raise
            usage = getattr(self.inner, "last_usage", None)
            measured = isinstance(usage, dict) and "input_tokens" in usage and "output_tokens" in usage
            if not measured:
                chars_in = sum(len(m.get("content") or "") for m in messages)
                usage = {"input_tokens": int(chars_in / self.ledger.cpt) + self.ledger.overhead, "output_tokens": int(len(text or "") / self.ledger.cpt) + 1}
            charged = self.ledger.cost(usage)
            entry.update(status="ok", usage=usage, usage_source="provider" if measured else "estimate", charged_usd=round(charged, 8))
            self.ledger.record(entry)
            self.last_usage = dict(usage, charged_usd=round(charged, 8), usage_source=entry["usage_source"])
            return text
        raise StopRun("model call failed after %d attempts (%s); execution stopped, not retried further" % (self.max_attempts, type(last).__name__))
