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
import { contracts, loadDeployment, rpcUrl, STATUS } from '../shared/chain.mjs';
import { buildResult, canonicalJson, parseJob, resultHash, resultSigningMessage, SANDBOX_IMAGE } from '../shared/index.mjs';
import { runJob } from './sandbox.mjs';
import { createX402Resources, send } from './x402.mjs';

const { values: args } = parseArgs({ options: { port: { type: 'string', default: '4401' }, cheat: { type: 'boolean', default: false }, label: { type: 'string' }, 'no-network': { type: 'boolean', default: false } } });
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

// The node's identity key signs results, submits redemptions and holds the bond.
function loadIdentity() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = join(STATE_DIR, 'identity.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ privateKey: ethers.Wallet.createRandom().privateKey }), { mode: 0o600 });
  return new ethers.Wallet(JSON.parse(readFileSync(file, 'utf8')).privateKey);
}

// Cheating mode: claim every test passed without running anything. Test names are read from
// the test files so the fake looks exactly like an honest result.
function fakeResult(job) {
  const tests = [];
  for (const f of job.files) {
    if (!f.path.startsWith('test_')) continue;
    for (const m of f.content.matchAll(/^def (test_[a-zA-Z0-9_]*)\s*\(/gm)) tests.push({ name: `${f.path}::${m[1]}`, passed: true });
  }
  return buildResult(job, { status: 'ok', exit_code: 0, tests });
}

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
      console.log(`[retry] ${label}: ${String(error.shortMessage ?? error.message).slice(0, 100)} (attempt ${i + 1}/${attempts})`);
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
  const context = await loadX402Context(AP4M_API_URL);
  const deployment = loadDeployment();
  const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
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
          try {
            const t0 = Date.now();
            const result = CHEAT ? fakeResult(job) : await runJob(job);
            const hash = resultHash(result);
            const sig = await identity.signMessage(resultSigningMessage(job.job_id, hash));
            graded++;
            console.log(`[grade] ${job.job_id} ${result.status} reward=${result.reward} hash=${hash.slice(0, 12)} ${Date.now() - t0}ms paid=${transactionHash.slice(0, 12)}${CHEAT ? ' (CHEAT)' : ''}`);
            if (!args['no-network']) {
              withRetry(`report ${job.job_id}`, () => postJson(`${COORDINATOR_URL}/results`, {
                job_id: job.job_id, spec: job, spec_hash: result.spec_hash, result_hash: hash, sig, provider: identity.address,
                buyer: agent, paid_tx: transactionHash, price_wei: priceWei, reward: result.reward,
              })).then((r) => { if (r.sampled) console.log(`[report] ${job.job_id} sampled for verification`); })
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
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, running, graded, jobs_known: countJobs(), uptime_s: Math.floor((Date.now() - startedAt) / 1000) });
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
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); x402.close().finally(() => process.exit(0)); });

  if (args['no-network']) return;

  // ── join the network: register, benchmark, bond, telemetry ───────────────
  const [xrp, rl] = await Promise.all([provider.getBalance(identity.address), rlusd.balanceOf(identity.address)]);
  console.log(`[node] wallet ${ethers.formatEther(xrp)} XRP, ${ethers.formatUnits(rl, 18)} RLUSD`);
  if (xrp === 0n) console.warn('[node] no XRP for gas: run scripts/fund-nodes.mjs');

  const reg = await withRetry('register', () => postJson(`${COORDINATOR_URL}/providers/register`, { address: identity.address, endpoint: PUBLIC_URL, specs: specs(), price_rlusd: PRICE_RLUSD, label: LABEL }));
  let onchain = await registry.providers(identity.address);
  if (STATUS[Number(onchain[1])] === 'suspended') throw new Error('this identity is suspended on-chain (slashed); use a new state directory');
  if (STATUS[Number(onchain[1])] === 'none') {
    const tx = await registry.connect(wallet).register(PUBLIC_URL);
    await tx.wait();
    console.log(`[node] registered on-chain ${tx.hash}`);
  }
  // Benchmark: run honestly even in cheat mode (a cheater passes the entry test too).
  const t0 = Date.now();
  const results = [];
  for (const spec of reg.challenge.jobs) {
    const job = parseJob(spec);
    const hash = resultHash(await runJob(job));
    results.push({ job_id: job.job_id, result_hash: hash, sig: await identity.signMessage(resultSigningMessage(job.job_id, hash)) });
  }
  const bench = await withRetry('benchmark', () => postJson(`${COORDINATOR_URL}/providers/${identity.address}/benchmark`, { results }));
  if (!bench.pass) throw new Error('benchmark failed');
  console.log(`[node] benchmark passed in ${Date.now() - t0}ms, attested ${bench.attest_tx}`);
  const bondWei = ethers.parseUnits(BOND_RLUSD, 18);
  onchain = await registry.providers(identity.address);
  if (BigInt(onchain[2]) < bondWei) {
    const need = bondWei - BigInt(onchain[2]);
    if ((await rlusd.balanceOf(identity.address)) < need) throw new Error(`need ${ethers.formatUnits(need, 18)} RLUSD for the bond: run scripts/fund-nodes.mjs`);
    await (await rlusd.connect(wallet).approve(deployment.registry, need)).wait();
    const tx = await registry.connect(wallet).bond(need);
    await tx.wait();
    console.log(`[node] bonded ${ethers.formatUnits(need, 18)} RLUSD ${tx.hash}`);
  }
  onchain = await registry.providers(identity.address);
  console.log(`[node] on-chain status: ${STATUS[Number(onchain[1])]}, bond ${ethers.formatUnits(onchain[2], 18)} RLUSD`);

  const beat = () => postJson(`${COORDINATOR_URL}/telemetry`, { provider: identity.address, load: running, graded, uptime_s: Math.floor((Date.now() - startedAt) / 1000) }).catch(() => {});
  beat();
  setInterval(beat, 5000).unref();
}

main().catch((error) => { console.error(error.shortMessage ?? error.message ?? error); process.exit(1); });
