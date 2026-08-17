"""Mini Crux extractor worker.

Owns exactly one thing: structural feature extraction from creative video (UC-2). All
product logic stays in TypeScript — see the deviation note in `CLAUDE.md`.
"""

from extractor.contracts import (
    Actor,
    agent_actor,
    is_message_id,
    is_trace_id,
    new_message_id,
    new_trace_id,
)

__all__ = [
    "Actor",
    "agent_actor",
    "is_message_id",
    "is_trace_id",
    "new_message_id",
    "new_trace_id",
]
