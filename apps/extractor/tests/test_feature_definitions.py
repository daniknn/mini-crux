"""The tripwire on feature definitions.

`cuts_per_second` measured with one cut threshold is not comparable with `cuts_per_second`
measured with another, but both are plausible numbers and nothing in the system notices
them being mixed. UC-5 then contrasts cohorts built partly from one definition and partly
from the other and reports a difference that is an artefact of a code change.

The pin below makes that impossible to do accidentally: changing a threshold fails this
test, and the only way to make it pass is to bump `FEATURE_SCHEMA_VERSION` and update the
digest — at which point `app.mark_features_stale()` and the reconciler re-measure the
existing rows under the new definition.
"""

from __future__ import annotations

import pytest

from extractor.features import (
    DEFINITIONS,
    FEATURE_SCHEMA_VERSION,
    MEASURABLE_FEATURES,
    CreativeFeatures,
    definitions_digest,
)

# Bump FEATURE_SCHEMA_VERSION and update this digest together, in the same commit.
# v3 adds semantic_hook_frame_s (UC-8 frame sampling).
EXPECTED_DIGEST = "d44472bacaee95ec"
EXPECTED_VERSION = 3


def test_definitions_are_pinned_to_the_schema_version() -> None:
    assert (FEATURE_SCHEMA_VERSION, definitions_digest()) == (EXPECTED_VERSION, EXPECTED_DIGEST), (
        "A feature definition changed. That is a schema_version bump: raise "
        "FEATURE_SCHEMA_VERSION, update EXPECTED_* here, and let the reconciler re-extract."
    )


def test_every_threshold_is_covered_by_the_digest() -> None:
    """A threshold left out of DEFINITIONS is a threshold the pin cannot protect."""
    from extractor import features as module

    thresholds = {
        name
        for name, value in vars(module).items()
        if name.isupper()
        and not name.startswith("_")
        and isinstance(value, (int, float, str))
        and name not in {"FEATURE_SCHEMA_VERSION"}
    }
    covered = {name.upper() for name in DEFINITIONS}
    assert thresholds == covered, f"not covered by definitions_digest(): {thresholds - covered}"


def test_skip_rejects_an_unknown_feature_name() -> None:
    # A typo'd skip reason reads downstream as a feature that was never attempted, which
    # silently changes the n of any cohort computed over it.
    features = CreativeFeatures()
    with pytest.raises(ValueError, match="unknown feature"):
        features.skip("audio_energy")


def test_skip_is_idempotent_and_ordered() -> None:
    features = CreativeFeatures()
    features.skip("text_density", "text_density", "duration_s")
    assert features.skipped_features == ["text_density", "duration_s"]


def test_measurable_features_match_the_row_shape() -> None:
    row = CreativeFeatures().to_row()
    for name in MEASURABLE_FEATURES:
        assert name in row
