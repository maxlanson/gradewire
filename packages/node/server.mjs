// Gradewire provider node: sells grading jobs over HTTP 402 and takes part in the network.
//
//   POST /jobs            unpaid: validate a job, return its paid resource URL and price
//   GET  /grade/{job_id}  x402: 402 with terms, then the signed grade once the Voucher is redeemed
//   GET  /health          liveness and load
//   GET  /info            identity, price, payout, sandbox image
//
// On start the node registers with the coordinator, passes its benchmark, registers and bonds
// RLUSD on-chain, then streams telemetry. Every grade is reported to the coordinator, which
// may sample it for verification.
//
// Usage: node packages/node/server.mjs [--port 4401] [--cheat] [--label "Grader A"]
// Env (from .env): AP4M_API_URL, PAYOUT_ADDRESS, MERCHANT_ID, PRICE_RLUSD, BOND_RLUSD,
// COORDINATOR_URL, NODE_STATE_DIR. The node's identity wallet (generated into the state dir)
// submits redemptions and holds the bond, so it needs testnet XRP and RLUSD: scripts/fund-nodes.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { loadX402Context } from '../ap4m/ap4m-x402.mjs';
import { describeError, contracts, loadDeployment, makeProvider, STATUS } from '../shared/chain.mjs';
import { buildResult, canonicalJson, parseJob, resultHash, resultSigningMessage, SANDBOX_IMAGE, SCRIPT_KIND } from '../shared/index.mjs';
import { runJob } from './sandbox.mjs';
import { createDisplay } from './display.mjs';
import { createX402Resources, send } from './x402.mjs';

const { values: args } = parseArgs({ options: { port: { type: 'string', default: '4401' }, cheat: { type: 'boolean', default: false }, label: { type: 'string' }, 'no-network': { type: 'boolean', default: false }, 'no-display': { type: 'boolean', default: false } } });
const PORT = Number(args.port);
const CHEAT = args.cheat;
const LABEL = args.label || `node-${PORT}`;
const AP4M_API_URL = (process.env.AP4M_API_URL || 'https://hackathon.ap4m.build').replace(/\/$/, '');
const COORDINATOR_URL = (process.env.COORDINATOR_URL || 'http://127.0.0.1:4500').replace(/\/$/, '');
const MERCHANT_ID = process.env.MERCHANT_ID || '';
const PAYOUT = process.env.PAYOUT_ADDRESS || '';
const PRICE_RLUSD = process.env.PRICE_RLUSD || '0.01';
const BOND_RLUSD = process.env.BOND_RLUSD || '0.01';
const STATE_DIR = process.env.NODE_STATE_DIR || `./.state/node-${PORT}`;
const PUBLIC_URL = (process.env.NODE_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const VERSION = '0.2.0';
const startedAt = Date.now();

// Whole-machine CPU use, sampled every 2 s from os.cpus() deltas, for /health and the panels.
let cpuPct = 0;
let lastCpu = os.cpus().map((c) => c.times);
setInterval(() => {
  const now = os.cpus().map((c) => c.times);
  let busy = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const a = lastCpu[i] || now[i], b = now[i];
    const idle = b.idle - a.idle;
    const all = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    busy += all - idle; total += all;
  }
  cpuPct = total > 0 ? Math.round((busy / total) * 100) : 0;
  lastCpu = now;
}, 2000).unref();

// The node's identity key signs results, submits redemptions and holds the bond.
function loadIdentity() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = join(STATE_DIR, 'identity.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ privateKey: ethers.Wallet.createRandom().privateKey }), { mode: 0o600 });
  return new ethers.Wallet(JSON.parse(readFileSync(file, 'utf8')).privateKey);
}

// Cheating mode: claim success without running anything.
//   python-fn-tests: every test passed. Test names are read from the test files so the fake
//                    looks exactly like an honest result.
//   python-script:   a clean exit with a canned, plausible-looking stdout. The verifier's
//                    re-run produces the real output, so the hashes differ and the cheat is caught.
function fakeResult(job) {
  if (job.kind === SCRIPT_KIND) return buildResult(job, { status: 'ok', exit_code: 0, output: '42\n', truncated: false });
  const tests = [];
  for (const f of job.files) {
    if (!f.path.startsWith('test_')) continue;
    for (const m of f.content.matchAll(/^def (test_[a-zA-Z0-9_]*)\s*\(/gm)) tests.push({ name: `${f.path}::${m[1]}`, passed: true });
  }
  return buildResult(job, { status: 'ok', exit_code: 0, tests });
}

async function getJson(url) { const res = await fetch(url); const data = await res.json(); if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error}`); return data; }
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${url} returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error ?? text.slice(0, 200)}`);
  return data;
}

async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (error) {
      if (i >= attempts) throw error;
      console.log(`[retry] ${label}: ${String(describeError(error)).slice(0, 100)} (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
}

function specs() {
  return { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 2 ** 30), os: `${os.platform()} ${os.release()}`, arch: os.arch(), gpu: null };
}

async function main() {
  if (!MERCHANT_ID || !PAYOUT) throw new Error('set MERCHANT_ID and PAYOUT_ADDRESS');
  const identity = loadIdentity();
  let display = createDisplay({ enabled: false });
  const context = await loadX402Context(AP4M_API_URL);
  const deployment = loadDeployment();
  const provider = makeProvider(deployment); // the x402 helper's VoucherRedeemed lookup needs chunked getLogs on Quicknode
  const wallet = identity.connect(provider);
  const { registry, rlusd } = contracts(provider, deployment);
  const priceWei = ethers.parseUnits(PRICE_RLUSD, 18).toString();

  // Jobs are persisted so a restart never orphans a job the buyer already paid for.
  const jobsDb = new DatabaseSync(join(STATE_DIR, 'jobs.sqlite'));
  jobsDb.exec('CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT');
  const getJob = (id) => { const row = jobsDb.prepare('SELECT spec FROM jobs WHERE job_id=?').get(id); return row ? JSON.parse(String(row.spec)) : undefined; };
  const countJobs = () => Number(jobsDb.prepare('SELECT count(*) AS n FROM jobs').get().n);
  let graded = 0;
  let running = 0;

  const x402 = createX402Resources({
    context, provider, submitter: wallet, stateDirectory: STATE_DIR, merchantParticipantId: MERCHANT_ID, payout: PAYOUT,
    resolve(url) {
      const m = url.match(/^(.*)\/grade\/(j_[a-z0-9]{8,40})$/);
      if (!m || m[1] !== PUBLIC_URL) return undefined;
      const job = getJob(m[2]);
      if (!job) return undefined;
      return {
        amount: priceWei,
        async produce({ transactionHash, agent }) {
          running++;
          display.event('job-start', { id: job.job_id, price: PRICE_RLUSD });
          try {
            const t0 = Date.now();
            let result;
            try { result = CHEAT ? fakeResult(job) : await runJob(job); } catch (error) {
              // The Voucher is already redeemed: never leave the buyer without a signed result.
              // A sandbox fault (Docker down, image missing) is reported as a health failure, not a grade.
              console.error(`[grade] ${job.job_id} sandbox fault: ${error.message}`);
              result = buildResult(job, { status: 'error', exit_code: -2, tests: [] });
            }
            const hash = resultHash(result);
            const sig = await identity.signMessage(resultSigningMessage(job.job_id, hash));
            graded++;
            console.log(`[grade] ${job.job_id} ${result.status} reward=${result.reward} hash=${hash.slice(0, 12)} ${Date.now() - t0}ms paid=${transactionHash.slice(0, 12)}${CHEAT ? ' (CHEAT)' : ''}`);
            display.event('job-done', { id: job.job_id, ms: Date.now() - t0, paid_tx: transactionHash, status: result.status, price: PRICE_RLUSD });
            if (!args['no-network']) {
              withRetry(`report ${job.job_id}`, () => postJson(`${COORDINATOR_URL}/results`, {
                job_id: job.job_id, spec: job, spec_hash: result.spec_hash, result_hash: hash, sig, provider: identity.address,
                buyer: agent, paid_tx: transactionHash, price_wei: priceWei, reward: result.reward, status: result.status,
              })).then((r) => { display.event('job-reported', { id: job.job_id, sampled: !!r.sampled }); if (r.sampled) { console.log(`[report] ${job.job_id} sampled for verification`); watchVerdict(job.job_id); } })
                .catch((e) => console.error(`[report] ${job.job_id}: ${e.message}`));
            }
            return { result, result_hash: hash, sig, provider: identity.address, paid_tx: transactionHash };
          } finally { running--; }
        },
      };
    },
  });

  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    const url = new URL(req.url, PUBLIC_URL);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, running, graded, jobs_known: countJobs(), uptime_s: Math.floor((Date.now() - startedAt) / 1000), cpu_pct: cpuPct, cores: os.cpus().length, loadavg: os.loadavg()[0], label: LABEL, provider: identity.address, cheat: CHEAT });
    if (req.method === 'GET' && url.pathname === '/info') {
      return send(res, 200, { provider: identity.address, label: LABEL, price_rlusd: PRICE_RLUSD, price_wei: priceWei, payout: PAYOUT, merchant_id: MERCHANT_ID, image: SANDBOX_IMAGE, version: VERSION, endpoint: PUBLIC_URL, specs: specs() });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 70_000) req.destroy(); });
      req.on('end', () => {
        let job;
        try { job = parseJob(JSON.parse(body)); } catch (error) { return send(res, 400, { error: error.message }); }
        if (BigInt(ethers.parseUnits(job.max_price, 18)) < BigInt(priceWei)) return send(res, 402, { error: 'max_price_below_price', price_rlusd: PRICE_RLUSD });
        const existing = getJob(job.job_id);
        if (existing && canonicalJson(existing) !== canonicalJson(job)) return send(res, 409, { error: 'job_id_in_use' });
        if (!existing) {
          if (countJobs() >= 10_000) return send(res, 503, { error: 'job_capacity_reached' });
          jobsDb.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.job_id, canonicalJson(job), Date.now());
        }
        return send(res, 200, { job_id: job.job_id, resource_url: `${PUBLIC_URL}/grade/${job.job_id}`, price_wei: priceWei, price_rlusd: PRICE_RLUSD });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/grade/')) return x402.serve(req, res, `${PUBLIC_URL}${url.pathname}`);
    return send(res, 404, { error: 'not_found' });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[node] ${LABEL} ${identity.address} selling grades at ${PUBLIC_URL}/grade/{job_id} for ${PRICE_RLUSD} RLUSD${CHEAT ? '  ** CHEAT MODE **' : ''}`);
  });
  display = createDisplay({ label: LABEL, address: identity.address, publicUrl: PUBLIC_URL, price: PRICE_RLUSD, cheat: CHEAT, enabled: process.stdout.isTTY && !args['no-display'] });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { display.stop(); server.close(); x402.close().finally(() => process.exit(0)); });

  // For the panel: follow a sampled job until its verdict lands, and refresh this node's
  // status, score and earned trust from the coordinator every few seconds.
  async function watchVerdict(jobId) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const v = await getJson(`${COORDINATOR_URL}/jobs/${jobId}/verdict`);
        if (v.verdict !== 'pending') { display.event('job-verdict', { id: jobId, verdict: v.verdict }); console.log(`[verdict] ${jobId}: ${v.verdict}${v.verdict === 'pass' ? ' (3 verifiers re-ran it, hashes match)' : v.verdict === 'fail' ? ' (result did not reproduce: bond slashed)' : ''}`); return; }
      } catch { /* coordinator unreachable; try again */ }
    }
  }
  async function refreshStatus() {
    try {
      const me = (await getJson(`${COORDINATOR_URL}/providers`)).providers.find((p) => p.address.toLowerCase() === identity.address.toLowerCase());
      if (me) display.event('status', { status: me.status, bond: Number(me.bond_rlusd).toFixed(2), score: me.score, trust: me.trust });
    } catch { /* keep the last known values */ }
  }

  if (args['no-network']) return;

  // ── join the network: register, benchmark, bond, telemetry ───────────────
  const bondWei = ethers.parseUnits(BOND_RLUSD, 18);
  const balances = async () => Promise.all([provider.getBalance(identity.address), rlusd.balanceOf(identity.address), registry.providers(identity.address)]);
  let [xrp, rl, onchain] = await balances();
  console.log(`[node] wallet ${ethers.formatEther(xrp)} XRP, ${ethers.formatUnits(rl, 18)} RLUSD`);
  // A node that joins from another laptop has no funds yet: print the address and wait for the
  // team to fund it (gas for registration and the RLUSD bond) instead of failing on the first tx.
  for (let waited = 0; (xrp < ethers.parseEther('0.5') || (BigInt(onchain[2]) < bondWei && rl < bondWei - BigInt(onchain[2]))); waited++) {
    if (waited === 0) display.event('status', { status: 'waiting for funding', note: `send 3 XRP + ${BOND_RLUSD} RLUSD to ${identity.address} (team laptop: node --env-file=.env scripts/fund-nodes.mjs --address ${identity.address})` });
    if (waited % 6 === 0) console.log(`[node] waiting for funding of ${identity.address}: needs 3 XRP for gas and ${BOND_RLUSD} RLUSD for the bond\n[node]   on the team laptop: node --env-file=.env scripts/fund-nodes.mjs --address ${identity.address}`);
    await new Promise((r) => setTimeout(r, 5000));
    [xrp, rl, onchain] = await balances();
  }

  display.event('status', { status: 'registering', note: '' });
  // On-chain registration first: the coordinator's benchmark challenge has a 60 s deadline, so it
  // must be requested right before the benchmark runs, not before a transaction that can take a while.
  onchain = await registry.providers(identity.address);
  if (STATUS[Number(onchain[1])] === 'suspended') throw new Error('this identity is suspended on-chain (slashed); use a new state directory');
  if (STATUS[Number(onchain[1])] === 'none') {
    const tx = await withRetry('register on-chain', async () => { const t = await registry.connect(wallet).register(PUBLIC_URL); await t.wait(); return t; });
    console.log(`[node] registered on-chain ${tx.hash}`);
  }
  const registerWithCoordinator = () => withRetry('register', () => postJson(`${COORDINATOR_URL}/providers/register`, { address: identity.address, endpoint: PUBLIC_URL, specs: specs(), price_rlusd: PRICE_RLUSD, label: LABEL }));
  let reg = await registerWithCoordinator();
  if (reg.challenge) {
    // Benchmark: run honestly even in cheat mode (a cheater passes the entry test too).
    const t0 = Date.now();
    const results = [];
    for (const spec of reg.challenge.jobs) {
      const job = parseJob(spec);
      const hash = resultHash(await runJob(job));
      results.push({ job_id: job.job_id, result_hash: hash, sig: await identity.signMessage(resultSigningMessage(job.job_id, hash)) });
    }
    display.event('status', { status: 'benchmark' });
    let bench = await withRetry('benchmark', () => postJson(`${COORDINATOR_URL}/providers/${identity.address}/benchmark`, { results }));
    if (!bench.pass) {
      console.log('[node] benchmark not accepted (most likely past its 60 s deadline); asking for a fresh challenge');
      reg = await registerWithCoordinator();
      const again = [];
      for (const spec of reg.challenge?.jobs ?? []) { const job = parseJob(spec); const hash = resultHash(await runJob(job)); again.push({ job_id: job.job_id, result_hash: hash, sig: await identity.signMessage(resultSigningMessage(job.job_id, hash)) }); }
      bench = reg.challenge ? await withRetry('benchmark', () => postJson(`${COORDINATOR_URL}/providers/${identity.address}/benchmark`, { results: again })) : { pass: true, attest_tx: 'already attested' };
      if (!bench.pass) throw new Error('benchmark failed twice');
    }
    console.log(`[node] benchmark passed in ${Date.now() - t0}ms, attested ${bench.attest_tx}`);
  } else {
    console.log('[node] already attested and bonded on-chain; the coordinator skipped the benchmark');
  }
  onchain = await registry.providers(identity.address);
  if (BigInt(onchain[2]) < bondWei) {
    const need = bondWei - BigInt(onchain[2]);
    if ((await rlusd.balanceOf(identity.address)) < need) throw new Error(`need ${ethers.formatUnits(need, 18)} RLUSD for the bond: run scripts/fund-nodes.mjs`);
    // The public RPC is load-balanced and occasionally answers a transaction with an unparseable
    // error; a node must not die at its bond step over that.
    await withRetry('approve bond', async () => { const t = await rlusd.connect(wallet).approve(deployment.registry, need); await t.wait(); });
    const tx = await withRetry('post bond', async () => { const t = await registry.connect(wallet).bond(need); await t.wait(); return t; });
    console.log(`[node] bonded ${ethers.formatUnits(need, 18)} RLUSD ${tx.hash}`);
  }
  onchain = await registry.providers(identity.address);
  console.log(`[node] on-chain status: ${STATUS[Number(onchain[1])]}, bond ${ethers.formatUnits(onchain[2], 18)} RLUSD`);

  const beat = () => postJson(`${COORDINATOR_URL}/telemetry`, { provider: identity.address, load: running, graded, uptime_s: Math.floor((Date.now() - startedAt) / 1000) }).catch(() => {});
  beat();
  setInterval(beat, 5000).unref();
  await refreshStatus();
  if (display.enabled) setInterval(refreshStatus, 5000).unref();
}

main().catch((error) => { console.error(describeError(error)); process.exit(1); });
