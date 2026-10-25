// Shared types and helpers: canonical JSON, hashing, job validation, result hashing.
// Provider nodes, verifiers and the trainer must all compute identical hashes, so every
// hash goes through canonicalJson() here and nowhere else.

import { createHash } from 'node:crypto';

// Python 3.12 slim, pinned by its multi-arch index digest so arm64 and amd64 machines
// run the same image release.
export const SANDBOX_IMAGE = 'python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704';
export const JOB_KIND = 'python-fn-tests';
export const MAX_JOB_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_S = 20;

// Keys sorted, no whitespace. Only plain JSON values are allowed (no undefined, NaN, Infinity).
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => {
      if (value[k] === undefined) throw new Error(`canonicalJson: undefined at ${k}`);
      return JSON.stringify(k) + ':' + canonicalJson(value[k]);
    }).join(',') + '}';
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Validates a grading job and returns it in canonical form. Throws on anything off-spec.
export function parseJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('job must be an object');
  const allowed = ['job_id', 'kind', 'image', 'timeout_s', 'files', 'reward_rule', 'max_price'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`unknown job field: ${key}`);
  const { job_id, kind, image, timeout_s = DEFAULT_TIMEOUT_S, files, reward_rule = 'fraction_passed', max_price } = input;
  if (typeof job_id !== 'string' || !/^j_[a-z0-9]{8,40}$/.test(job_id)) throw new Error('job_id must match j_[a-z0-9]{8,40}');
  if (kind !== JOB_KIND) throw new Error(`kind must be ${JOB_KIND}`);
  if (image !== SANDBOX_IMAGE) throw new Error('image must be the pinned sandbox image');
  if (!Number.isInteger(timeout_s) || timeout_s < 1 || timeout_s > 60) throw new Error('timeout_s must be 1..60');
  if (reward_rule !== 'fraction_passed') throw new Error('reward_rule must be fraction_passed');
  if (typeof max_price !== 'string' || !/^\d+(\.\d{1,18})?$/.test(max_price)) throw new Error('max_price must be a decimal string');
  if (!Array.isArray(files) || files.length < 1 || files.length > 16) throw new Error('files must be 1..16 entries');
  const seen = new Set();
  const cleanFiles = files.map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string' || Object.keys(f).length !== 2) throw new Error('file must be {path, content}');
    if (!/^[a-z0-9_]{1,40}\.py$/.test(f.path)) throw new Error(`bad file path: ${f.path}`);
    if (seen.has(f.path)) throw new Error(`duplicate file: ${f.path}`);
    seen.add(f.path);
    return { path: f.path, content: f.content };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!cleanFiles.some((f) => f.path.startsWith('test_'))) throw new Error('job needs at least one test_*.py file');
  const job = { job_id, kind, image, timeout_s, files: cleanFiles, reward_rule, max_price };
  if (Buffer.byteLength(canonicalJson(job)) > MAX_JOB_BYTES) throw new Error('job exceeds 64 KiB');
  return job;
}

export const specHash = (job) => sha256(canonicalJson(job));

// Builds the canonical result that gets hashed. Tests sorted by name; reward = passed / total.
export function buildResult(job, { status, exit_code, tests }) {
  const sorted = [...tests].map((t) => ({ name: t.name, passed: t.passed === true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const passed = sorted.filter((t) => t.passed).length;
  const reward = status === 'ok' && sorted.length > 0 ? Math.round((passed / sorted.length) * 1e6) / 1e6 : 0;
  return { job_id: job.job_id, spec_hash: specHash(job), status, exit_code, tests: sorted, reward };
}

export const resultHash = (result) => sha256(canonicalJson(result));

// The message a provider signs (EIP-191) to bind itself to a result.
export const resultSigningMessage = (jobId, hash) => `gradewire:result:v1:${jobId}:${hash}`;
