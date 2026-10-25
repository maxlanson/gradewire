import { test } from 'node:test';
import assert from 'node:assert/strict';

import { logRange, splitRange } from './chain.mjs';

test('logRange: Quicknode hosts get the Discover-plan limit, everything else 2000', () => {
  assert.equal(logRange('https://solemn-white-sea.xrplevm-testnet.quiknode.pro/abc/'), 5);
  assert.equal(logRange('https://rpc.testnet.xrplevm.org'), 2000);
  assert.equal(logRange('not a url'), 2000);
});

test('splitRange: inclusive chunks no wider than the span, covering every block once', () => {
  assert.deepEqual(splitRange(10, 10, 5), [[10, 10]]);
  assert.deepEqual(splitRange(10, 15, 5), [[10, 15]]);
  assert.deepEqual(splitRange(10, 16, 5), [[10, 15], [16, 16]]);
  assert.deepEqual(splitRange(0, 13, 5), [[0, 5], [6, 11], [12, 13]]);
  assert.deepEqual(splitRange(5, 4, 5), []);
  for (const [a, b] of splitRange(100, 2100, 2000)) assert.ok(b - a <= 2000 && a >= 100 && b <= 2100);
});
