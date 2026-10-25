// Gradewire coordinator: provider registry, benchmark attestation, result intake, sampling,
// on-chain verification tasks, verdict/slash tracking, scores, telemetry, SSE event feed and
// the dashboard. One process, SQLite state, no build step.
//
// Usage: node --env-file=.env packages/coordinator/index.mjs [--port 4500]
// Env: COORDINATOR_PRIVATE_KEY, SAMPLING_RATE (default 0.5), QUICKNODE_RPC_URL (optional),
//      QUICKNODE_WEBHOOK_SECRET (optional; required header on /webhooks/quicknode).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';
import { PARTICIPANT_LEDGER_INTERFACE } from '@ap4m/sdk';

import { contracts, describeError, hex32, jobIdBytes, loadDeployment, makeProvider, STATUS } from '../shared/chain.mjs';
import { trustOf } from '../shared/trust.mjs';
import { canonicalJson, JOB_KIND, parseJob, resultHash, resultSigningMessage, SANDBOX_IMAGE, sha256 } from '../shared/index.mjs';
import { runJob } from '../node/sandbox.mjs';
import { ROLLOUTS } from '../../tasks/rollouts.mjs';
import { createAnchor } from './anchor.mjs';

const { values: args } = parseArgs({ options: { port: { type: 'string', default: '4500' } } });
const PORT = Number(args.port);
const STATE_DIR = process.env.COORDINATOR_STATE_DIR || './.state/coordinator';
const SAMPLING_RATE = Number(process.env.SAMPLING_RATE || '0.5');
const FULL_SAMPLING_UNTIL = Number(process.env.FULL_SAMPLING_UNTIL || '3'); // clean checks before the rate drops
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || '3'); // unverified jobs a fully trusted node may hold
const TRUST_OPTS = { samplingRate: SAMPLING_RATE, fullSamplingUntil: FULL_SAMPLING_UNTIL, maxInflight: MAX_INFLIGHT };
const MERCHANT_ID = (process.env.MERCHANT_ID || '0xb6aa1d849d8cce69e3acad00f3e938870f0ba3677404ba389e3d2b7b910fd80e').toLowerCase();
const HERE = dirname(fileURLToPath(import.meta.url));

if (!process.env.COORDINATOR_PRIVATE_KEY) { console.error('set COORDINATOR_PRIVATE_KEY'); process.exit(1); }

// ── state ─────────────────────────────────────────────────────────────────────
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(STATE_DIR, 'coordinator.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS providers (
  address TEXT PRIMARY KEY, endpoint TEXT, specs TEXT, price_rlusd TEXT, status TEXT NOT NULL DEFAULT 'registered',
  bond_wei TEXT NOT NULL DEFAULT '0', benchmark_hash TEXT, attest_tx TEXT, jobs_ok INTEGER NOT NULL DEFAULT 0,
  verified_ok INTEGER NOT NULL DEFAULT 0, verified_fail INTEGER NOT NULL DEFAULT 0, heartbeats INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL, last_seen INTEGER, label TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS benchmarks (provider TEXT PRIMARY KEY, challenge TEXT NOT NULL, expected TEXT NOT NULL, issued_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, id_hash TEXT NOT NULL, spec TEXT NOT NULL, spec_hash TEXT NOT NULL, buyer TEXT, provider TEXT NOT NULL,
  price_wei TEXT, paid_tx TEXT, result_hash TEXT NOT NULL, reward REAL, sampled INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'pending', task_id INTEGER, task_tx TEXT, verdict_tx TEXT, slash_tx TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS jobs_hash ON jobs(id_hash);
CREATE TABLE IF NOT EXISTS verifications (task_id INTEGER NOT NULL, operator TEXT NOT NULL, matched INTEGER NOT NULL, operator_hash TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, operator)) STRICT;
CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, tx TEXT, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS payments (tx TEXT NOT NULL, log_index INTEGER NOT NULL, channel_id TEXT, agent TEXT, submitter TEXT, amount_wei TEXT, block INTEGER, at INTEGER NOT NULL, PRIMARY KEY (tx, log_index)) STRICT;
CREATE TABLE IF NOT EXISTS seen_logs (key TEXT PRIMARY KEY, source TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS telemetry (provider TEXT NOT NULL, at INTEGER NOT NULL, load REAL, graded INTEGER, uptime_s INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS budgets (agent TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL) STRICT;`);
try { db.exec('ALTER TABLE providers ADD COLUMN first_seen INTEGER'); } catch { /* already present */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN anchor_tx TEXT'); } catch { /* already present */ }
const q = (sql) => db.prepare(sql);
// Native XRPL anchoring is on unless ANCHOR_XRPL=0 (it needs the XRPL Testnet faucet once).
const anchorer = process.env.ANCHOR_XRPL === '0' ? null : createAnchor(STATE_DIR);
const now = () => Date.now();
const low = (a) => String(a).toLowerCase();
// Latest spending limits posted by each paying agent (POST /agent/budget): Channel caps and spend.
const budgets = new Map(q('SELECT body FROM budgets').all().map((r) => { const b = JSON.parse(r.body); return [b.agent, b]; }));

// ── chain ─────────────────────────────────────────────────────────────────────
const deployment = loadDeployment();
const provider = makeProvider(deployment); // splits getLogs ranges for Quicknode's 5-block limit
const wallet = new ethers.Wallet(process.env.COORDINATOR_PRIVATE_KEY, provider);
const { registry, serviceManager } = contracts(provider, deployment);
const registryW = registry.connect(wallet);
const smW = serviceManager.connect(wallet);
const EXPLORER = deployment.explorerUrl;
let txQueue = Promise.resolve(); // serialize coordinator transactions (one nonce source)
const sendTx = (label, fn) => {
  const p = txQueue.then(async () => { const tx = await fn(); const r = await tx.wait(); console.log(`[tx] ${label} ${r.hash}`); return r; });
  txQueue = p.catch(() => {});
  return p;
};

// ── events (SSE) ──────────────────────────────────────────────────────────────
const clients = new Set();
function emit(type, data) {
  const at = now();
  q('INSERT INTO events(type,data,at) VALUES (?,?,?)').run(type, JSON.stringify(data), at);
  const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, at })}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();

// ── scoring ───────────────────────────────────────────────────────────────────
function scoreOf(p) {
  if (p.status === 'suspended') return 0;
  const passRate = (p.verified_ok + 1) / (p.verified_ok + p.verified_fail + 1); // Laplace-smoothed
  // Uptime: heartbeats received vs expected (one per 5 s) since the first heartbeat. A node
  // that has not reported yet is still onboarding (benchmark, bond) for its first minute.
  let uptime;
  if (!p.first_seen) uptime = now() - p.registered_at < 60_000 ? 1 : 0;
  else uptime = Math.min(1, p.heartbeats / (Math.floor((now() - p.first_seen) / 5000) + 1));
  const onTime = 1;
  return Math.round((0.6 * passRate + 0.3 * uptime + 0.1 * onTime) * 1000) / 1000;
}
// Trust earned per verified job: one more job in flight per clean check (up to MAX_INFLIGHT),
// lighter sampling after FULL_SAMPLING_UNTIL clean checks, suspension on a failed check.
const trustFor = (p) => trustOf(p, TRUST_OPTS);
const samplingRateOf = (p) => trustFor(p).sampling_rate;
function providerView(p) {
  return {
    address: p.address, endpoint: p.endpoint, label: p.label, price_rlusd: p.price_rlusd, status: p.status,
    bond_rlusd: ethers.formatUnits(BigInt(p.bond_wei), 18), score: scoreOf(p), sampling_rate: samplingRateOf(p), trust: trustFor(p),
    jobs_ok: p.jobs_ok, verified_ok: p.verified_ok, verified_fail: p.verified_fail, last_seen: p.last_seen, attest_tx: p.attest_tx,
    specs: p.specs ? JSON.parse(p.specs) : null,
  };
}
const getProvider = (a) => q('SELECT * FROM providers WHERE address=?').get(low(a));
const allProviders = () => q('SELECT * FROM providers ORDER BY registered_at').all();
const pushProvider = (a) => { const p = getProvider(a); if (p) emit('provider', providerView(p)); };

// ── benchmark ─────────────────────────────────────────────────────────────────
function benchmarkJobs() {
  const picks = [ROLLOUTS[0], ROLLOUTS[3], ROLLOUTS[7]];
  return picks.map((r) => parseJob({ job_id: `j_${randomBytes(8).toString('hex')}`, kind: JOB_KIND, image: SANDBOX_IMAGE, timeout_s: 20, files: r.files, reward_rule: 'fraction_passed', max_price: '0' }));
}

// ── log handling (shared by the local watcher and the Quicknode webhook) ──────
const registryIface = registry.interface;
const smIface = serviceManager.interface;
const jobByHash = (h) => q('SELECT * FROM jobs WHERE id_hash=?').get(low(h));

async function handleLog(log, source) {
  const key = `${log.transactionHash}:${Number(log.index ?? log.logIndex)}`;
  if (q('SELECT 1 FROM seen_logs WHERE key=?').get(key)) return false;
  q('INSERT INTO seen_logs VALUES (?,?)').run(key, source);
  if (source === 'quicknode') console.log(`[quicknode] log ${key} from the Stream (block ${Number(log.blockNumber)})`);
  const addr = low(log.address);
  const tx = log.transactionHash;
  if (addr === low(deployment.serviceManager)) {
    const ev = smIface.parseLog({ topics: [...log.topics], data: log.data });
    if (!ev) return;
    if (ev.name === 'NewTaskCreated') {
      const job = jobByHash(ev.args.jobId);
      if (job) { q('UPDATE jobs SET task_id=?, task_tx=? WHERE id=?').run(Number(ev.args.taskId), tx, job.id); emit('task', { task_id: Number(ev.args.taskId), job_id: job.id, provider: job.provider, provider_hash: ev.args.providerResultHash, tx, source, explorer: `${EXPLORER}/tx/${tx}` }); }
    } else if (ev.name === 'TaskResponded') {
      const taskId = Number(ev.args.taskId);
      q('INSERT OR IGNORE INTO verifications VALUES (?,?,?,?,?,?)').run(taskId, low(ev.args.operator), ev.args.matched ? 1 : 0, ev.args.operatorHash, tx, now());
      const job = q('SELECT * FROM jobs WHERE task_id=?').get(taskId);
      emit('response', { task_id: taskId, job_id: job?.id, provider: job?.provider, operator: ev.args.operator, matched: ev.args.matched, operator_hash: ev.args.operatorHash, tx, explorer: `${EXPLORER}/tx/${tx}` });
    } else if (ev.name === 'VerdictPosted') {
      const taskId = Number(ev.args.taskId);
      const pass = ev.args.pass;
      const job = q('SELECT * FROM jobs WHERE task_id=?').get(taskId) ?? jobByHash(ev.args.jobId);
      if (job) {
        q('UPDATE jobs SET verdict=?, verdict_tx=? WHERE id=?').run(pass ? 'pass' : 'fail', tx, job.id);
        q(pass ? 'UPDATE providers SET verified_ok=verified_ok+1 WHERE address=?' : 'UPDATE providers SET verified_fail=verified_fail+1, status=\'suspended\' WHERE address=?').run(job.provider);
        if (!pass) q('INSERT INTO incidents(provider,kind,detail,tx,at) VALUES (?,?,?,?,?)').run(job.provider, 'fraud', `verification of ${job.id} failed: provider hash ${job.result_hash.slice(0, 12)}… did not reproduce`, tx, now());
        emit('verdict', { task_id: taskId, job_id: job.id, provider: job.provider, pass, tx, source, explorer: `${EXPLORER}/tx/${tx}` });
        pushProvider(job.provider);
        if (anchorer) {
          anchorer.anchor('verdict', { task_id: taskId, job_id: job.id, provider: job.provider, pass, result_hash: job.result_hash, evm_tx: tx })
            .then((a) => { q('UPDATE jobs SET anchor_tx=? WHERE id=?').run(a.hash, job.id); emit('anchor', { task_id: taskId, job_id: job.id, provider: job.provider, pass, xrpl_tx: a.hash, url: a.url }); })
            .catch((e) => console.error(`[anchor] ${job.id}: ${e.message}`));
        }
      }
    }
  } else if (addr === low(deployment.registry)) {
    const ev = registryIface.parseLog({ topics: [...log.topics], data: log.data });
    if (!ev) return;
    const p = ev.args.provider ? low(ev.args.provider) : null;
    if (ev.name === 'Bonded' && p) {
      q('UPDATE providers SET bond_wei=? WHERE address=?').run(ev.args.total.toString(), p);
      await syncStatus(p);
      emit('bond', { provider: p, amount_rlusd: ethers.formatUnits(ev.args.amount, 18), total_rlusd: ethers.formatUnits(ev.args.total, 18), tx, explorer: `${EXPLORER}/tx/${tx}` });
      pushProvider(p);
    } else if (ev.name === 'Slashed' && p) {
      const job = jobByHash(ev.args.jobId);
      q('UPDATE providers SET bond_wei=\'0\', status=\'suspended\' WHERE address=?').run(p);
      if (job) q('UPDATE jobs SET slash_tx=? WHERE id=?').run(tx, job.id);
      q('INSERT INTO incidents(provider,kind,detail,tx,at) VALUES (?,?,?,?,?)').run(p, 'slash', `bond slashed: ${ethers.formatUnits(ev.args.refund, 18)} RLUSD refunded to ${ev.args.buyer}, ${ethers.formatUnits(ev.args.verifierReward, 18)} to verifiers`, tx, now());
      emit('slash', { provider: p, job_id: job?.id, buyer: ev.args.buyer, refund_rlusd: ethers.formatUnits(ev.args.refund, 18), verifier_reward_rlusd: ethers.formatUnits(ev.args.verifierReward, 18), treasury_rlusd: ethers.formatUnits(ev.args.treasuryShare, 18), tx, source, explorer: `${EXPLORER}/tx/${tx}` });
      pushProvider(p);
    } else if (ev.name === 'BondWithdrawn' && p) {
      await syncStatus(p);
      q('INSERT INTO incidents(provider,kind,detail,tx,at) VALUES (?,?,?,?,?)').run(p, 'bond', `withdrew ${ethers.formatUnits(ev.args.amount, 18)} RLUSD of bond with approver signature`, tx, now());
      emit('bond', { provider: p, amount_rlusd: `-${ethers.formatUnits(ev.args.amount, 18)}`, total_rlusd: ethers.formatUnits(BigInt(getProvider(p)?.bond_wei ?? '0'), 18), withdrawn: true, tx, explorer: `${EXPLORER}/tx/${tx}` });
      pushProvider(p);
    } else if (ev.name === 'ProviderAttested' && p) {
      await syncStatus(p);
      pushProvider(p);
    } else if (ev.name === 'ProviderRegistered' && p) {
      await syncStatus(p);
      pushProvider(p);
    }
  } else if (addr === low(deployment.paymentLedger)) {
    let ev;
    try { ev = PARTICIPANT_LEDGER_INTERFACE.parseLog({ topics: [...log.topics], data: log.data }); } catch { return; }
    if (!ev || ev.name !== 'VoucherRedeemed') return;
    if (low(ev.args.merchantId) !== MERCHANT_ID) return;
    q('INSERT OR IGNORE INTO payments VALUES (?,?,?,?,?,?,?,?)').run(tx, Number(log.index ?? log.logIndex), ev.args.channelId, ev.args.agent, ev.args.submitter, ev.args.amount.toString(), Number(log.blockNumber), now());
    const job = q('SELECT id, provider FROM jobs WHERE paid_tx=?').get(tx);
    emit('payment', { tx, channel_id: ev.args.channelId, agent: ev.args.agent, submitter: ev.args.submitter, provider: job?.provider ?? low(ev.args.submitter), job_id: job?.id, amount_rlusd: ethers.formatUnits(ev.args.amount, 18), source, explorer: `${EXPLORER}/tx/${tx}` });
  }
}

async function syncStatus(address) {
  const onchain = await registry.providers(address);
  const status = STATUS[Number(onchain[1])];
  const p = getProvider(address);
  if (!p) return;
  if (status === 'suspended' || (status === 'active' && p.status !== 'suspended')) q('UPDATE providers SET status=?, bond_wei=? WHERE address=?').run(status, onchain[2].toString(), low(address));
  else q('UPDATE providers SET bond_wei=? WHERE address=?').run(onchain[2].toString(), low(address));
}

async function watchChain() {
  // A fresh database starts a little behind the head (fresh counters for a demo run); an
  // existing one resumes exactly where it stopped so no event is missed across restarts.
  const saved = q('SELECT value FROM meta WHERE key=\'last_block\'').get()?.value;
  let from = saved ? Number(saved) : Math.max(deployment.deployBlock, (await provider.getBlockNumber()) - 5);
  const addresses = [deployment.serviceManager, deployment.registry, deployment.paymentLedger];
  for (;;) {
    try {
      const head = await provider.getBlockNumber();
      if (head >= from) {
        const to = Math.min(head, from + 2000);
        const logs = await provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
        logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
        for (const log of logs) await handleLog(log, 'rpc');
        from = to + 1;
        q('INSERT INTO meta VALUES (\'last_block\',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(String(from));
      }
    } catch (error) { console.error(`[watch] ${describeError(error)}`); }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function send(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), 'Access-Control-Allow-Origin': '*' });
  res.end(encoded);
}
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolvePromise(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function snapshot() {
  const jobs = q('SELECT id, provider, buyer, price_wei, paid_tx, result_hash, reward, sampled, verdict, task_id, task_tx, verdict_tx, slash_tx, anchor_tx, created_at FROM jobs ORDER BY created_at DESC LIMIT 100').all();
  const verifications = q('SELECT * FROM verifications ORDER BY at DESC LIMIT 100').all();
  const incidents = q('SELECT * FROM incidents ORDER BY at DESC LIMIT 50').all();
  const payments = q('SELECT * FROM payments ORDER BY at DESC LIMIT 100').all();
  const totals = {
    grades: q('SELECT count(*) n FROM jobs').get().n,
    paid_rlusd: ethers.formatUnits(payments.reduce((a, p) => a + BigInt(p.amount_wei), 0n), 18),
    verified: q('SELECT count(*) n FROM jobs WHERE verdict IN (\'pass\',\'fail\')').get().n,
    caught: q('SELECT count(*) n FROM jobs WHERE verdict=\'fail\'').get().n,
  };
  return { providers: allProviders().map(providerView), jobs, verifications, incidents, payments, totals, budgets: [...budgets.values()], explorer: EXPLORER, deployment: { registry: deployment.registry, serviceManager: deployment.serviceManager, paymentLedger: deployment.paymentLedger, operators: deployment.operators }, sampling_rate: SAMPLING_RATE };
}

const dashboardPath = resolve(HERE, '../dashboard/index.html');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
      let html;
      try { html = readFileSync(dashboardPath); } catch { return send(res, 404, { error: 'dashboard not built yet' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (req.method === 'GET' && path === '/state') return send(res, 200, snapshot());
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && path === '/providers') {
      const min = Number(url.searchParams.get('min_score') ?? '0');
      const list = allProviders().map(providerView).filter((p) => p.score >= min && (url.searchParams.get('status') ? p.status === url.searchParams.get('status') : true));
      list.sort((a, b) => (Number(a.price_rlusd) / Math.max(a.score, 1e-6)) - (Number(b.price_rlusd) / Math.max(b.score, 1e-6)));
      return send(res, 200, { providers: list });
    }
    if (req.method === 'POST' && path === '/providers/register') {
      const body = await readBody(req);
      const address = ethers.getAddress(body.address);
      if (typeof body.endpoint !== 'string' || !/^https?:\/\//.test(body.endpoint)) return send(res, 400, { error: 'endpoint required' });
      const existing = getProvider(address);
      if (existing?.status === 'suspended') return send(res, 403, { error: 'provider is suspended' });
      if (!existing) q('INSERT INTO providers(address,endpoint,specs,price_rlusd,label,registered_at) VALUES (?,?,?,?,?,?)').run(low(address), body.endpoint, JSON.stringify(body.specs ?? {}), String(body.price_rlusd ?? ''), body.label ?? null, now());
      else q('UPDATE providers SET endpoint=?, specs=?, price_rlusd=?, label=COALESCE(?, label) WHERE address=?').run(body.endpoint, JSON.stringify(body.specs ?? {}), String(body.price_rlusd ?? ''), body.label ?? null, low(address));
      // Benchmark challenge: three jobs with answers the coordinator computes itself.
      const challenge = benchmarkJobs();
      const expected = {};
      for (const job of challenge) expected[job.job_id] = resultHash(await runJob(job));
      q('INSERT INTO benchmarks VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET challenge=excluded.challenge, expected=excluded.expected, issued_at=excluded.issued_at').run(low(address), JSON.stringify(challenge), JSON.stringify(expected), now());
      pushProvider(address);
      return send(res, 200, { provider: low(address), challenge: { jobs: challenge, deadline_s: 60 }, registry: deployment.registry, rlusd: deployment.rlusd });
    }
    const bench = path.match(/^\/providers\/(0x[0-9a-fA-F]{40})\/benchmark$/);
    if (req.method === 'POST' && bench) {
      const address = low(bench[1]);
      const row = q('SELECT * FROM benchmarks WHERE provider=?').get(address);
      if (!row) return send(res, 404, { error: 'no challenge issued' });
      const body = await readBody(req);
      const expected = JSON.parse(row.expected);
      const results = body.results ?? [];
      let ok = results.length === Object.keys(expected).length;
      for (const r of results) {
        if (expected[r.job_id] !== r.result_hash) ok = false;
        try { if (low(ethers.verifyMessage(resultSigningMessage(r.job_id, r.result_hash), r.sig)) !== address) ok = false; } catch { ok = false; }
      }
      const elapsed = now() - row.issued_at;
      if (elapsed > 60_000) ok = false;
      if (!ok) { q('INSERT INTO incidents(provider,kind,detail,at) VALUES (?,?,?,?)').run(address, 'health', `benchmark failed (${elapsed}ms)`, now()); pushProvider(address); return send(res, 200, { pass: false }); }
      const benchmarkHash = hex32(sha256(canonicalJson(results.map((r) => r.result_hash).sort())));
      const receipt = await sendTx(`attest ${address.slice(0, 8)}`, () => registryW.attest(address, benchmarkHash));
      q('UPDATE providers SET benchmark_hash=?, attest_tx=? WHERE address=?').run(benchmarkHash, receipt.hash, address);
      await syncStatus(address);
      pushProvider(address);
      return send(res, 200, { pass: true, elapsed_ms: elapsed, attest_tx: receipt.hash });
    }
    if (req.method === 'POST' && path === '/results') {
      const body = await readBody(req);
      const job = parseJob(body.spec);
      if (job.job_id !== body.job_id) return send(res, 400, { error: 'job_id mismatch' });
      const providerAddr = low(body.provider);
      const p = getProvider(providerAddr);
      if (!p) return send(res, 404, { error: 'unknown provider' });
      if (low(ethers.verifyMessage(resultSigningMessage(body.job_id, body.result_hash), body.sig)) !== providerAddr) return send(res, 400, { error: 'bad signature' });
      if (q('SELECT 1 FROM jobs WHERE id=?').get(job.job_id)) return send(res, 200, { duplicate: true });
      // A sandbox fault after payment (status 'error') is a health failure, not a grade: it is
      // not sampled (an honest machine would not reproduce it) and it costs reliability, not the bond.
      const fault = body.status === 'error';
      const rate = samplingRateOf(p);
      const sampled = !fault && p.status !== 'suspended' && Math.random() < rate;
      const verdict = fault ? 'error' : sampled ? 'pending' : 'not_sampled';
      q('INSERT INTO jobs(id,id_hash,spec,spec_hash,buyer,provider,price_wei,paid_tx,result_hash,reward,sampled,verdict,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(job.job_id, low(jobIdBytes(job.job_id)), canonicalJson(job), body.spec_hash, body.buyer ? low(body.buyer) : null, providerAddr, String(body.price_wei ?? ''), body.paid_tx ?? null, body.result_hash, Number(body.reward ?? 0), sampled ? 1 : 0, verdict, now());
      if (fault) {
        q('INSERT INTO incidents(provider,kind,detail,at) VALUES (?,?,?,?)').run(providerAddr, 'health', `sandbox fault on ${job.job_id} after payment; grade unusable`, now());
        q('UPDATE providers SET heartbeats=MAX(0, heartbeats-6) WHERE address=?').run(providerAddr); // dents the uptime term
      } else q('UPDATE providers SET jobs_ok=jobs_ok+1 WHERE address=?').run(providerAddr);
      emit('job', { job_id: job.job_id, provider: providerAddr, buyer: body.buyer, reward: body.reward, result_hash: body.result_hash, paid_tx: body.paid_tx, price_rlusd: body.price_wei ? ethers.formatUnits(BigInt(body.price_wei), 18) : null, sampled, verdict, explorer: body.paid_tx ? `${EXPLORER}/tx/${body.paid_tx}` : null });
      if (fault) pushProvider(providerAddr);
      if (sampled) {
        sendTx(`task ${job.job_id}`, () => smW.createVerificationTask(jobIdBytes(job.job_id), providerAddr, body.buyer || wallet.address, hex32(body.result_hash)))
          .catch((e) => { console.error(`[task] ${job.job_id}: ${describeError(e)}`); q('UPDATE jobs SET verdict=\'error\' WHERE id=?').run(job.job_id); emit('verdict', { job_id: job.job_id, provider: providerAddr, pass: null, error: describeError(e) }); });
      }
      return send(res, 200, { sampled, verdict, sampling_rate: rate });
    }
    const byHash = path.match(/^\/jobs\/by-hash\/(0x[0-9a-fA-F]{64})$/);
    if (req.method === 'GET' && byHash) { const job = jobByHash(byHash[1]); return job ? send(res, 200, { job_id: job.id }) : send(res, 404, { error: 'unknown job hash' }); }
    const jobRoute = path.match(/^\/jobs\/(j_[a-z0-9]+)\/(verdict|spec)$/);
    if (req.method === 'GET' && jobRoute) {
      const job = q('SELECT * FROM jobs WHERE id=?').get(jobRoute[1]);
      if (!job) return send(res, 404, { error: 'unknown job' });
      if (jobRoute[2] === 'spec') return send(res, 200, { job: JSON.parse(job.spec), provider_result_hash: job.result_hash, provider: job.provider });
      const jp = getProvider(job.provider);
      return send(res, 200, { job_id: job.id, verdict: job.verdict, sampled: !!job.sampled, task_id: job.task_id, verdict_tx: job.verdict_tx, slash_tx: job.slash_tx, provider: job.provider, trust: jp ? trustFor(jp) : null });
    }
    if (req.method === 'POST' && path === '/agent/budget') {
      const body = await readBody(req);
      let agent;
      try { agent = low(ethers.getAddress(low(body.agent))); } catch { return send(res, 400, { error: 'agent address required' }); }
      if (!Array.isArray(body.channels)) return send(res, 400, { error: 'channels required' });
      const wei = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : '0');
      const budget = {
        agent,
        channels: body.channels.map((c) => ({ provider: c.provider ? low(c.provider) : null, label: c.label ?? null, channel_id: c.channel_id ?? null, cap_wei: wei(c.cap_wei), spent_wei: wei(c.spent_wei), status: String(c.status ?? 'unknown') })),
        max_price_wei: wei(body.max_price_wei), min_score: String(body.min_score ?? ''), at: now(),
      };
      budgets.set(agent, budget);
      q('INSERT INTO budgets VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET body=excluded.body, at=excluded.at').run(agent, JSON.stringify(budget), budget.at);
      emit('budget', budget);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/telemetry') {
      const body = await readBody(req);
      const address = low(body.provider);
      if (!getProvider(address)) return send(res, 404, { error: 'unknown provider' });
      q('INSERT INTO telemetry VALUES (?,?,?,?,?)').run(address, now(), Number(body.load ?? 0), Number(body.graded ?? 0), Number(body.uptime_s ?? 0));
      q('UPDATE providers SET heartbeats=heartbeats+1, last_seen=?, first_seen=COALESCE(first_seen, ?) WHERE address=?').run(now(), now(), address);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/webhooks/quicknode') {
      if (process.env.QUICKNODE_WEBHOOK_SECRET && req.headers['x-gradewire-secret'] !== process.env.QUICKNODE_WEBHOOK_SECRET) return send(res, 401, { error: 'bad secret' });
      const body = await readBody(req);
      // Streams payloads: a flat array of raw log objects from our filter, {data: [...]} if the
      // Stream wraps it, or the unfiltered "logs" dataset (arrays nested per block/tx).
      const logs = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      let handled = 0, duplicates = 0;
      for (const raw of logs.flat(Infinity)) {
        if (!raw?.topics || !raw.address) continue;
        const fresh = await handleLog({ address: raw.address, topics: raw.topics, data: raw.data ?? '0x', transactionHash: raw.transactionHash, index: Number(raw.logIndex ?? raw.index ?? 0), blockNumber: Number(raw.blockNumber) }, 'quicknode');
        if (fresh === false) duplicates++; else handled++;
      }
      console.log(`[quicknode] webhook delivery: ${handled} new, ${duplicates} already seen`);
      return send(res, 200, { handled, duplicates });
    }
    return send(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(`[http] ${req.method} ${path}: ${describeError(error)}`);
    return send(res, 500, { error: describeError(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[coordinator] ${wallet.address} on http://127.0.0.1:${PORT}  registry ${deployment.registry}  sm ${deployment.serviceManager}  sampling ${SAMPLING_RATE} (100% for first ${FULL_SAMPLING_UNTIL} verified jobs)`);
  // WATCH_CHAIN=0 turns the polling watcher off so a Quicknode Stream is the only event source
  // (otherwise the 4 s poll usually wins the race and Stream deliveries are deduplicated).
  if (process.env.WATCH_CHAIN === '0') console.log('[coordinator] chain polling disabled (WATCH_CHAIN=0): events come from the Quicknode Stream webhook only');
  else watchChain();
});
