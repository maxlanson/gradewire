// Runs one grading job in a locked-down Docker container and returns the canonical result.
// Verifiers reuse this exact function, so any change here changes every result_hash.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildResult, SCRIPT_KIND } from '../shared/index.mjs';

const RUNNER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../sandbox');
const MARKER = 'GRADEWIRE_RESULT ';
const MAX_OUTPUT = 1024 * 1024;

function docker(args, { timeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut }); });
  });
}

// job must already be validated with parseJob().
export async function runJob(job) {
  const workDir = mkdtempSync(join(tmpdir(), 'gradewire-job-'));
  const name = `gradewire-${job.job_id}-${randomBytes(4).toString('hex')}`;
  try {
    chmodSync(workDir, 0o755);
    for (const file of job.files) { // already sorted by path
      const path = join(workDir, file.path);
      writeFileSync(path, file.content, { mode: 0o644 });
      utimesSync(path, 0, 0); // SOURCE_DATE_EPOCH=0
    }
    utimesSync(workDir, 0, 0);
    const args = [
      'run', '--rm', '--name', name, '--hostname', 'gradewire', // fixed hostname: Docker's default is the random container id
      '--network', 'none',
      '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
      '--read-only', '--tmpfs', '/tmp:size=64m',
      '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--env', 'TZ=UTC', '--env', 'LANG=C.UTF-8', '--env', 'PYTHONHASHSEED=0',
      '--env', 'SOURCE_DATE_EPOCH=0', '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1',
      '--workdir', '/work',
      '-v', `${workDir}:/work:ro`, '-v', `${RUNNER_DIR}/runner.py:/runner/runner.py:ro`,
      job.image, 'python', '-B', '/runner/runner.py',
    ];
    const run = await docker(args, { timeoutMs: job.timeout_s * 1000 });
    if (run.timedOut) {
      await docker(['rm', '-f', name]);
      return buildResult(job, { status: 'timeout', exit_code: -1, tests: [] });
    }
    // Docker's own failures (125-127) mean the sandbox never ran: that is a provider fault, not a result.
    if (run.code >= 125 && run.code <= 127) throw new Error(`sandbox failed to start (${run.code}): ${run.stderr.trim()}`);
    const line = run.stdout.split('\n').filter((l) => l.startsWith(MARKER)).pop();
    if (run.code !== 0 || !line) return buildResult(job, { status: 'error', exit_code: run.code, tests: [] });
    let parsed;
    try { parsed = JSON.parse(line.slice(MARKER.length)); } catch { parsed = null; }
    if (!parsed) return buildResult(job, { status: 'error', exit_code: run.code, tests: [] });
    if (job.kind === SCRIPT_KIND) {
      // status 'ok' means the program ran to completion (any exit code); the runner's own
      // exit code is 0 in that case. A malformed runner line is a sandbox error, not a result.
      if (typeof parsed.output !== 'string' || !Number.isInteger(parsed.exit_code) || typeof parsed.truncated !== 'boolean') {
        return buildResult(job, { status: 'error', exit_code: run.code, tests: [] });
      }
      return buildResult(job, { status: 'ok', exit_code: parsed.exit_code, output: parsed.output, truncated: parsed.truncated });
    }
    const { tests } = parsed;
    if (!Array.isArray(tests) || !tests.every((t) => t && typeof t.name === 'string')) {
      return buildResult(job, { status: 'error', exit_code: run.code, tests: [] });
    }
    return buildResult(job, { status: 'ok', exit_code: 0, tests });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
