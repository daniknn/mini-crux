"""Cross-cutting contracts, mirrored from `packages/core` (DashOne §3).

Two implementations of the same contract is a real risk, so the rule is narrow: this
module may only ever contain the *shared* primitives (`trace_id`, `message_id`, `actor`),
and TypeScript is the reference. If the two drift, TypeScript wins.

Note the import name: the package is `python-ulid` but it imports as `ulid`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ulid import ULID

TRACE_PREFIX = "trc_"
MESSAGE_PREFIX = "msg_"

ActorType = Literal["user", "schedule", "agent", "operator"]


def new_trace_id() -> str:
    """Mint a trace id.

    Called once at ingress and then propagated unchanged. The worker almost never calls
    this: it inherits the `trace_id` from the job row it claimed. Minting a second one
    mid-chain silently breaks the join across logs, jobs and audit.
    """
    return f"{TRACE_PREFIX}{ULID()}"


def new_message_id() -> str:
    """Mint a message id — the idempotency key for one unit of durable work."""
    return f"{MESSAGE_PREFIX}{ULID()}"


def is_trace_id(value: str) -> bool:
    return value.startswith(TRACE_PREFIX) and len(value) == len(TRACE_PREFIX) + 26


def is_message_id(value: str) -> bool:
    return value.startswith(MESSAGE_PREFIX) and len(value) == len(MESSAGE_PREFIX) + 26


@dataclass(frozen=True, slots=True)
class Actor:
    """Who or what initiated a chain of work, preserved end to end."""

    type: ActorType
    id: str
    label: str | None = None

    def to_json(self) -> dict[str, str]:
        payload = {"type": self.type, "id": self.id}
        if self.label is not None:
            payload["label"] = self.label
        return payload


def agent_actor(name: str) -> Actor:
    """The worker acting on its own behalf, e.g. during feature extraction."""
    return Actor(type="agent", id=name)
