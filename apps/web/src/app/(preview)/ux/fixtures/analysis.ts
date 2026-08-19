import type { LatestAnalysis } from '@mini-crux/db/dashboard'

/**
 * A published contrast and a refused one, both invented.
 *
 * Five of the seven features are tested and two are not, so the page renders both the finding
 * cards and the "sin medir" cards in one screen — the second kind exists precisely because a
 * feature the extractor could not measure must not silently disappear from the list, and a
 * fixture that tested all seven would never show it.
 *
 * Only one feature clears the adjusted threshold. That ratio is the honest one: six contrasts
 * over a panel this size mostly return "no distinguimos", and the review needs to see what
 * that card looks like far more than it needs to see six green ones.
 */
export const ANALYSIS: LatestAnalysis = {
  runId: '01JZ8Q4M7V2N6X0K3D5R9T1B4C',
  runDate: '2026-08-19',
  panelDate: '2026-08-18',
  panelAgeDays: 79,
  featureSchemaVersion: 3,
  extractorVersions: ['0.4.2'],
  analysisVersion: '1.2.0',
  outcome: 'published',
  failedGate: null,
  gateDetail: {},
  nLong: 34,
  nShort: 41,
  excluded: {
    // The excluded middle is the biggest bucket and that is by design: 14–60 días is the
    // band where "longevo" and "efímero" are not distinguishable, so it is dropped.
    middle: 47,
    gaps: 12,
    noStart: 9,
    notExtracted: 32,
  },
  censoringRateLong: 0.44,
  strataTotal: 11,
  strataUsed: 7,
  strataDropped: 4,
  features: [
    {
      feature: 'first_cut_time_s',
      nLong: 31,
      nShort: 38,
      z: -3.14,
      p: 0.0017,
      qValue: 0.0085,
      probabilitySuperiority: 0.32,
      rankBiserial: -0.36,
      strataUsed: 7,
      strataDropped: 4,
    },
    {
      feature: 'cuts_per_second',
      nLong: 31,
      nShort: 38,
      z: 1.62,
      p: 0.105,
      qValue: 0.263,
      probabilitySuperiority: 0.59,
      rankBiserial: 0.18,
      strataUsed: 7,
      strataDropped: 4,
    },
    {
      feature: 'duration_s',
      nLong: 34,
      nShort: 41,
      z: 0.47,
      p: 0.638,
      qValue: 0.638,
      probabilitySuperiority: 0.53,
      rankBiserial: 0.05,
      strataUsed: 7,
      strataDropped: 4,
    },
    {
      feature: 'text_in_first_2s',
      nLong: 29,
      nShort: 36,
      z: 2.05,
      p: 0.04,
      qValue: 0.134,
      probabilitySuperiority: 0.63,
      rankBiserial: 0.25,
      strataUsed: 6,
      strataDropped: 5,
    },
    {
      // UC-8's semantic feature, and it has the smallest n of the five: the tagger runs
      // behind the extractor, so its cohort is a subset of everything above.
      feature: 'has_people_on_screen',
      nLong: 22,
      nShort: 27,
      z: 1.18,
      p: 0.238,
      qValue: 0.397,
      probabilitySuperiority: 0.57,
      rankBiserial: 0.14,
      strataUsed: 5,
      strataDropped: 6,
    },
  ],
  tagBreakdowns: [
    {
      tag: 'hook_type',
      counts: [
        { value: 'testimonial', nLong: 7, nShort: 4 },
        { value: 'demo', nLong: 5, nShort: 3 },
        { value: 'problem_solution', nLong: 4, nShort: 9 },
        { value: 'ugc', nLong: 3, nShort: 6 },
        { value: 'offer', nLong: 2, nShort: 4 },
        { value: 'other', nLong: 1, nShort: 1 },
      ],
      untaggedLong: 12,
      untaggedShort: 14,
      nLong: 34,
      nShort: 41,
    },
    {
      tag: 'tone',
      counts: [
        { value: 'humoristico', nLong: 3, nShort: 5 },
        { value: 'emocional', nLong: 8, nShort: 4 },
        { value: 'informativo', nLong: 6, nShort: 7 },
        { value: 'urgente', nLong: 2, nShort: 9 },
        { value: 'aspiracional', nLong: 3, nShort: 2 },
        { value: 'other', nLong: 0, nShort: 0 },
      ],
      untaggedLong: 12,
      untaggedShort: 14,
      nLong: 34,
      nShort: 41,
    },
  ],
}

/**
 * A run that refused, with the gate's own numbers.
 *
 * `features` and `tagBreakdowns` are empty and that is a database guarantee, not an omission
 * — migrations 0007 and 0014 refuse to store either against a run that did not publish. The
 * refusal copy is rendered from `gateDetail`, so the headline is a countdown rather than an
 * apology.
 */
export const ANALYSIS_REFUSED: LatestAnalysis = {
  runId: '01JZ8Q4M7V2N6X0K3D5R9T1B4D',
  runDate: '2026-06-24',
  panelDate: '2026-06-23',
  panelAgeDays: 23,
  featureSchemaVersion: 3,
  extractorVersions: ['0.4.2'],
  analysisVersion: '1.2.0',
  outcome: 'refused',
  failedGate: 'cohort_n',
  gateDetail: {
    required_n: 30,
    n_long: 8,
    n_short: 26,
    shortfall_n: 22,
  },
  nLong: 8,
  nShort: 26,
  excluded: {
    middle: 14,
    gaps: 5,
    noStart: 3,
    notExtracted: 19,
  },
  censoringRateLong: 0.88,
  strataTotal: 5,
  strataUsed: 2,
  strataDropped: 3,
  features: [],
  tagBreakdowns: [],
}
