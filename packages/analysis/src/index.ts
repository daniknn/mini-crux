export {
  ANALYSIS_FEATURES,
  assembleCohorts,
  LONG_LIVED_ABOVE_DAYS,
  MixedFeatureVersionsError,
  placeCreative,
  PLACEMENTS,
  SHORT_LIVED_BELOW_DAYS,
  stratify,
} from './cohorts.ts'
export type {
  AnalysisFeature,
  Cohort,
  CohortAssembly,
  CohortMember,
  Exclusion,
  FeatureStrata,
  PanelCreative,
  Placement,
} from './cohorts.ts'
export { ANALYSIS_VERSION, runContrasts } from './contrast.ts'
export type { ContrastSet, FeatureContrast } from './contrast.ts'
export { benjaminiHochberg } from './fdr.ts'
export {
  evaluateGates,
  MAX_CENSORING_RATE,
  MIN_COHORT_N,
  MIN_PANEL_AGE_DAYS,
  MIN_STRATA,
} from './gating.ts'
export type { GateDetail, GateId, GateInput, GatePass, GateRefusal, GateVerdict } from './gating.ts'
export { erfc, twoSidedNormalP } from './normal.ts'
export {
  classifyProxyAd,
  classifyProxyCorpus,
  deriveVerdict,
  evaluateProxyValidationGate,
  MIN_ADVERTISERS_USED,
  MIN_FINISHED_ADS,
} from './proxy-validation.ts'
export type {
  ClassifiedProxyAd,
  ProxyCorpusClassification,
  ProxyExclusionReason,
  ProxyGateDetail,
  ProxyGateId,
  ProxyGateInput,
  ProxyGatePass,
  ProxyGateRefusal,
  ProxyGateVerdict,
  ProxyVerdict,
  RawProxyAd,
  ReachBound,
} from './proxy-validation.ts'
export { CONFIDENCE_ALPHA, naivePooledEstimate, withinAdvertiserRegression } from './regression.ts'
export type { FinishedAd, NaiveEstimate, WithinAdvertiserRegression } from './regression.ts'
export { regularizedIncompleteBeta, studentTCritical, twoSidedStudentP } from './student-t.ts'
export { describeTagDistribution, HOOK_TYPES, TONES } from './tag-distribution.ts'
export type { DescriptiveTag, TagBreakdown, TagValueCount } from './tag-distribution.ts'
export { vanElteren } from './van-elteren.ts'
export type { ContrastResult, Stratum } from './van-elteren.ts'
