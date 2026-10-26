/**
 * Copy latency is measured at several boundaries, not as one ambiguous "execution" number.
 * The provider response is an acknowledgement; the follower's MT5 deal timestamp must be
 * correlated separately before calling a trade broker-confirmed.
 */
export interface CopyLatencyMilestones {
  masterExecutedAtMs?: number | null;
  detectedAtMs: number;
  eventStoredAtMs?: number | null;
  followerStartedAtMs: number;
  reservationStartedAtMs: number;
  reservedAtMs: number;
  brokerStartedAtMs: number;
  providerRespondedAtMs: number;
}

export interface CopyLatencySample {
  sourceToDetectionMs: number | null;
  detectionToStoreMs: number | null;
  followerPreflightMs: number | null;
  reservationMs: number | null;
  reservedToBrokerMs: number | null;
  providerResponseMs: number | null;
  detectionToProviderResponseMs: number | null;
  sourceToProviderResponseMs: number | null;
}

/** Invalid or clock-skewed cross-system timestamps are unknown, never reported as 0 ms. */
export function elapsedMs(start: number | null | undefined, end: number, maxMs = 600_000): number | null {
  if (start == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const elapsed = end - start;
  return elapsed >= 0 && elapsed <= maxMs ? Math.round(elapsed) : null;
}

export function copyLatencySample(m: CopyLatencyMilestones): CopyLatencySample {
  return {
    sourceToDetectionMs: elapsedMs(m.masterExecutedAtMs, m.detectedAtMs),
    detectionToStoreMs: elapsedMs(m.detectedAtMs, m.eventStoredAtMs ?? Number.NaN),
    followerPreflightMs: elapsedMs(m.followerStartedAtMs, m.reservationStartedAtMs),
    reservationMs: elapsedMs(m.reservationStartedAtMs, m.reservedAtMs),
    reservedToBrokerMs: elapsedMs(m.reservedAtMs, m.brokerStartedAtMs),
    providerResponseMs: elapsedMs(m.brokerStartedAtMs, m.providerRespondedAtMs),
    detectionToProviderResponseMs: elapsedMs(m.detectedAtMs, m.providerRespondedAtMs),
    sourceToProviderResponseMs: elapsedMs(m.masterExecutedAtMs, m.providerRespondedAtMs),
  };
}
