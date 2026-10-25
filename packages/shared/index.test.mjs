// Unit tests for the shared hashing and validation layer. Run: node --test 'packages/shared/*.test.mjs'
//
// Every provider, verifier and the trainer must produce identical hashes from the same inputs,
// so the fixtures below pin the exact sha256 values. If one changes, every deployed node and
// verifier must be updated together or honest providers will start failing verification.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildResult, canonicalJson, JOB_KIND, parseJob, resultHash, SANDBOX_IMAGE, SCRIPT_KIND, specHash } from './index.mjs';

const base = { image: SANDBOX_IMAGE, timeout_s: 5, max_price: '0.01' };
const TESTS_PY = 'from solution import add\n\ndef test_a():\n    assert add(1, 2) == 3\n\ndef test_b():\n    assert add(0, 0) == 0\n';
const SOLUTION_PY = 'def add(a, b):\n    return a + b\n';

const scriptJob = () => parseJob({ ...base, job_id: 'j_fixture0001', kind: SCRIPT_KIND, files: [{ path: 'main.py', content: 'print(6 * 7)\n' }] });
const testJob = () => parseJob({ ...base, job_id: 'j_fixture0002', kind: JOB_KIND, files: [{ path: 'test_solution.py', content: TESTS_PY }, { path: 'solution.py', content: SOLUTION_PY }] });

describe('canonicalJson', () => {
  it('sorts keys and strips whitespace', () => {
    assert.equal(canonicalJson({ b: [1, { z: true, a: null }], a: 'x' }), '{"a":"x","b":[1,{"a":null,"z":true}]}');
  });
  it('rejects values that would not round-trip', () => {
    assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
    assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
  });
});

describe('parseJob', () => {
  it('accepts a script job with main.py', () => {
    const job = scriptJob();
    assert.equal(job.kind, SCRIPT_KIND);
    assert.deepEqual(job.files.map((f) => f.path), ['main.py']);
  });
  it('accepts a script job with helper modules next to main.py', () => {
    const job = parseJob({ ...base, job_id: 'j_fixture0003', kind: SCRIPT_KIND, files: [{ path: 'util.py', content: 'X = 1\n' }, { path: 'main.py', content: 'import util\nprint(util.X)\n' }] });
    assert.deepEqual(job.files.map((f) => f.path), ['main.py', 'util.py']); // sorted by path
  });
  it('rejects a script job without main.py', () => {
    assert.throws(() => parseJob({ ...base, job_id: 'j_fixture0004', kind: SCRIPT_KIND, files: [{ path: 'run.py', content: 'print(1)\n' }] }), /script job needs main\.py/);
  });
  it('rejects a test job containing main.py', () => {
    assert.throws(() => parseJob({ ...base, job_id: 'j_fixture0005', kind: JOB_KIND, files: [{ path: 'main.py', content: 'print(1)\n' }, { path: 'test_x.py', content: 'def test_a(): pass\n' }] }), /must not contain main\.py/);
  });
  it('rejects a test job without a test file', () => {
    assert.throws(() => parseJob({ ...base, job_id: 'j_fixture0006', kind: JOB_KIND, files: [{ path: 'solution.py', content: SOLUTION_PY }] }), /test_\*\.py/);
  });
  it('rejects unknown kinds and fields', () => {
    assert.throws(() => parseJob({ ...base, job_id: 'j_fixture0007', kind: 'bash', files: [{ path: 'main.py', content: '' }] }), /kind must be one of/);
    assert.throws(() => parseJob({ ...base, job_id: 'j_fixture0008', kind: SCRIPT_KIND, files: [{ path: 'main.py', content: '' }], extra: 1 }), /unknown job field/);
  });
  it('is order-independent: the spec hash ignores file order', () => {
    const a = parseJob({ ...base, job_id: 'j_fixture0002', kind: JOB_KIND, files: [{ path: 'test_solution.py', content: TESTS_PY }, { path: 'solution.py', content: SOLUTION_PY }] });
    const b = parseJob({ ...base, job_id: 'j_fixture0002', kind: JOB_KIND, files: [{ path: 'solution.py', content: SOLUTION_PY }, { path: 'test_solution.py', content: TESTS_PY }] });
    assert.equal(specHash(a), specHash(b));
  });
});

describe('buildResult (python-fn-tests)', () => {
  it('sorts tests by name and rewards the fraction passed', () => {
    const job = testJob();
    const r1 = buildResult(job, { status: 'ok', exit_code: 0, tests: [{ name: 'test_solution.py::test_b', passed: false }, { name: 'test_solution.py::test_a', passed: true }] });
    const r2 = buildResult(job, { status: 'ok', exit_code: 0, tests: [{ name: 'test_solution.py::test_a', passed: true }, { name: 'test_solution.py::test_b', passed: 'nope' }] });
    assert.deepEqual(r1.tests.map((t) => t.name), ['test_solution.py::test_a', 'test_solution.py::test_b']);
    assert.equal(r1.reward, 0.5);
    assert.equal(resultHash(r1), resultHash(r2)); // order and truthiness are canonicalised
    assert.deepEqual(Object.keys(r1).sort(), ['exit_code', 'job_id', 'reward', 'spec_hash', 'status', 'tests']);
  });
  it('gives reward 0 on timeout and error', () => {
    const job = testJob();
    assert.equal(buildResult(job, { status: 'timeout', exit_code: -1, tests: [] }).reward, 0);
    assert.equal(buildResult(job, { status: 'error', exit_code: 1, tests: [{ name: 'x', passed: true }] }).reward, 0);
  });
});

describe('buildResult (python-script)', () => {
  it('keeps the output and rewards a clean exit', () => {
    const r = buildResult(scriptJob(), { status: 'ok', exit_code: 0, output: '42\n', truncated: false });
    assert.deepEqual(r, { job_id: 'j_fixture0001', spec_hash: specHash(scriptJob()), status: 'ok', exit_code: 0, output: '42\n', truncated: false, reward: 1 });
    assert.deepEqual(Object.keys(r).sort(), ['exit_code', 'job_id', 'output', 'reward', 'spec_hash', 'status', 'truncated']);
  });
  it('keeps the output but gives reward 0 on a non-zero exit', () => {
    const r = buildResult(scriptJob(), { status: 'ok', exit_code: 1, output: 'before\n', truncated: false });
    assert.equal(r.output, 'before\n');
    assert.equal(r.reward, 0);
  });
  it('blanks the output on timeout and error so those results are stable', () => {
    const job = scriptJob();
    for (const status of ['timeout', 'error']) {
      const a = buildResult(job, { status, exit_code: -1, output: 'partial\n', truncated: true });
      const b = buildResult(job, { status, exit_code: -1 });
      assert.deepEqual(a, b);
      assert.equal(a.output, '');
      assert.equal(a.truncated, false);
      assert.equal(a.reward, 0);
    }
  });
  it('is canonical regardless of the input object shape', () => {
    const job = scriptJob();
    const a = buildResult(job, { truncated: false, output: '42\n', exit_code: 0, status: 'ok' });
    const b = buildResult(job, { status: 'ok', exit_code: 0, output: '42\n', truncated: false, tests: [{ name: 'ignored', passed: true }] });
    assert.equal(resultHash(a), resultHash(b));
    assert.equal('tests' in a, false);
  });
});

describe('resultHash fixtures (pinned)', () => {
  it('script job spec and results', () => {
    const job = scriptJob();
    assert.equal(specHash(job), '5c505442d89aeb61b03468ada948843350ea8e2b0ab58420708a6a06a3dbb574');
    assert.equal(resultHash(buildResult(job, { status: 'ok', exit_code: 0, output: '42\n', truncated: false })), 'b561260d751ad2c2b72f401c081ea1d8e33f61bacb1a3efb20cce10bea8a3eb1');
    assert.equal(resultHash(buildResult(job, { status: 'timeout', exit_code: -1 })), '300f218917e8e3cb01ddb750e951e26708a3c75d490ff8e9c052c6be144643fa');
  });
  it('test job spec and result', () => {
    const job = testJob();
    assert.equal(specHash(job), '45c867dff275a3f1eddfe407193abb916978d4d4cc5f5c4ff75b0882fc779d80');
    const r = buildResult(job, { status: 'ok', exit_code: 0, tests: [{ name: 'test_solution.py::test_b', passed: false }, { name: 'test_solution.py::test_a', passed: true }] });
    assert.equal(resultHash(r), 'b5d4eaeaa8157b4527a286d7565432fcaa8ebca3e6915bb3b0a6641f562302e6');
  });
});
