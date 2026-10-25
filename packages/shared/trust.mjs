// Trust earned per verified job. Every node starts with one job at a time and every result
// re-run; each clean check lets it hold one more unverified job (up to MAX_INFLIGHT), and after
// FULL_SAMPLING_UNTIL clean checks only a fraction of its jobs are re-run. A failed check
// suspends the node; going offline restarts the clean streak (one job at a time again). Shared by the coordinator (which computes it) and the paying agent
// (which enforces it as its payment-gating depth).

export const TRUST_DEFAULTS = { samplingRate: 0.5, fullSamplingUntil: 3, maxInflight: 3 };

export function trustOf(p, options = {}) {
  const { samplingRate, fullSamplingUntil, maxInflight } = { ...TRUST_DEFAULTS, ...options };
  // trust_penalty is set to the node's verified_ok when it goes offline: the clean streak restarts.
  const ok = Math.max(0, Number(p.verified_ok || 0) - Number(p.trust_penalty || 0));
  const fail = Number(p.verified_fail || 0);
  const base = { clean_checks: ok, failed_checks: fail };
  if (p.status === 'suspended') return { ...base, level: 'suspended', max_inflight: 0, sampling_rate: 1 };
  if (fail > 0) return { ...base, level: 'probation', max_inflight: 1, sampling_rate: 1 };
  const inflight = Math.min(maxInflight, 1 + ok);
  const sampling = ok < fullSamplingUntil ? 1 : samplingRate;
  const level = ok === 0 ? 'new' : inflight < maxInflight || sampling >= 1 ? 'earning' : 'trusted';
  return { ...base, level, max_inflight: inflight, sampling_rate: sampling };
}

export function describeTrust(t) {
  if (!t) return '—';
  if (t.max_inflight === 0) return 'suspended';
  const n = t.max_inflight;
  return `${n} job${n === 1 ? '' : 's'} at a time, ${t.sampling_rate >= 1 ? 'every one re-run' : `${Math.round(t.sampling_rate * 100)}% re-run`}`;
}
