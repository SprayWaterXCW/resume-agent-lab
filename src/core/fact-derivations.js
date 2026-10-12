/** Shared contract for deterministic projections. These names never contain profile values. */
export const FACT_DERIVATIONS = Object.freeze({
  COPY: "copy", LATEST_EDUCATION: "latest_education", LATEST_RECORD: "latest_record",
  BACHELOR_EDUCATION: "bachelor_education", DATE_YEAR: "date_year", DATE_MONTH: "date_month", DATE_DAY: "date_day",
  EXAM_LEVEL: "exam_level", EXAM_SCORE: "exam_score", REGION_JOIN: "region_join",
  AWARD_LEVEL: "award_level", AWARD_SUMMARY: "award_summary", AWARD_SUMMARY_JOIN: "award_summary_join",
  SALARY_MONTHLY: "salary_monthly", SALARY_ANNUAL: "salary_annual", LANGUAGE_SUMMARY: "language_summary",
});
export const FACT_DERIVATION_NAMES = Object.freeze(Object.values(FACT_DERIVATIONS));
