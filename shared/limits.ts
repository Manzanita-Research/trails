// Protocol limits also drive collector batching. Counts bound synchronous hub work.
export const INGEST_LIMITS = {
  sessionTuples: 2_048,
  batchTuples: 4_096,
  spanMinutes: 31 * 24 * 60,
} as const
