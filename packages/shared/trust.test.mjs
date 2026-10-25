import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeTrust, trustOf } from './trust.mjs';

const t = (verified_ok, verified_fail = 0, status = 'active') => trustOf({ verified_ok, verified_fail, status });

test('a new node runs one job at a time with every job re-run', () => {
  assert.deepEqual(t(0), { clean_checks: 0, failed_checks: 0, level: 'new', max_inflight: 1, sampling_rate: 1 });
  assert.equal(describeTrust(t(0)), '1 job at a time, every one re-run');
});

test('each clean check earns one more job in flight, capped at 3', () => {
  assert.equal(t(1).max_inflight, 2);
  assert.equal(t(2).max_inflight, 3);
  assert.equal(t(10).max_inflight, 3);
  assert.equal(t(1).level, 'earning');
  assert.equal(t(2).sampling_rate, 1);
});

test('after three clean checks sampling drops to the configured rate', () => {
  assert.deepEqual(t(3), { clean_checks: 3, failed_checks: 0, level: 'trusted', max_inflight: 3, sampling_rate: 0.5 });
  assert.equal(describeTrust(t(3)), '3 jobs at a time, 50% re-run');
  assert.equal(trustOf({ verified_ok: 3 }, { samplingRate: 0.2, maxInflight: 5 }).max_inflight, 4);
  assert.equal(trustOf({ verified_ok: 3 }, { samplingRate: 0.2 }).sampling_rate, 0.2);
});

test('a failed check means suspension; a past failure on an active node means probation', () => {
  assert.equal(t(5, 1, 'suspended').max_inflight, 0);
  assert.equal(describeTrust(t(5, 1, 'suspended')), 'suspended');
  assert.deepEqual(t(5, 1), { clean_checks: 5, failed_checks: 1, level: 'probation', max_inflight: 1, sampling_rate: 1 });
});
