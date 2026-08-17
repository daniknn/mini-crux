"""The contracts here must stay byte-compatible with `packages/core` — these tests are
the tripwire for drift between the two implementations."""

from __future__ import annotations

from extractor.contracts import (
    Actor,
    agent_actor,
    is_message_id,
    is_trace_id,
    new_message_id,
    new_trace_id,
)


def test_trace_id_is_prefixed_ulid() -> None:
    trace_id = new_trace_id()
    assert trace_id.startswith("trc_")
    assert is_trace_id(trace_id)
    # 26 characters of ULID body — same length check the TypeScript side applies.
    assert len(trace_id) == 30


def test_message_id_is_prefixed_ulid() -> None:
    message_id = new_message_id()
    assert message_id.startswith("msg_")
    assert is_message_id(message_id)
    assert len(message_id) == 30


def test_the_two_id_types_never_validate_as_each_other() -> None:
    assert not is_trace_id(new_message_id())
    assert not is_message_id(new_trace_id())


def test_ids_are_distinct() -> None:
    assert len({new_trace_id() for _ in range(500)}) == 500


def test_trace_ids_sort_by_creation_time() -> None:
    ids = [new_trace_id() for _ in range(50)]
    assert ids == sorted(ids)


def test_actor_omits_absent_label() -> None:
    # Not `label: None` — the actor is stored as jsonb and a null would land in every
    # audit row.
    assert agent_actor("extractor").to_json() == {"type": "agent", "id": "extractor"}
    assert Actor(type="user", id="u1", label="Ana").to_json() == {
        "type": "user",
        "id": "u1",
        "label": "Ana",
    }
