// Gradewire provider node: sells grading jobs over HTTP 402.
//
//   POST /jobs            unpaid: validate a job, return its paid resource URL and price
//   GET  /grade/{job_id}  x402: 402 with terms, then the signed grade once the Voucher is redeemed
//   GET  /health          liveness and load
//   GET  /info            identity, price, payout, sandbox image
//
// Usage: node packages/node/server.mjs [--port 4401] [--cheat]
// Env (from .env): AP4M_API_URL, MERCHANT_PRIVATE_KEY (submits redemptions), PAYOUT_ADDRESS,
// MERCHANT_ID, PRICE_RLUSD, NODE_STATE_DIR.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { loadX402Context } from '../ap4m/ap4m-x402.mjs';
import { buildResult, canonicalJson, parseJob, resultHash, resultSigningMessage, SANDBOX_IMAGE } from '../shared/index.mjs';
import { runJob } from './sandbox.mjs';
import { createX402Resources, send } from './x402.mjs';

const { values: args } = parseArgs({ options: { port: { type: 'string', default: '4401' }, cheat: { type: 'boolean', default: false } } });
const PORT = Number(args.port);
const CHEAT = args.cheat;
const AP4M_API_URL = (process.env.AP4M_API_URL || 'https://hackathon.ap4m.build').replace(/\/$/, '');
const MERCHANT_ID = process.env.MERCHANT_ID || '';
const PAYOUT = process.env.PAYOUT_ADDRESS || '';
const SUBMITTER_KEY = process.env.MERCHANT_PRIVATE_KEY || '';
const PRICE_RLUSD = process.env.PRICE_RLUSD || '0.01';
const STATE_DIR = process.env.NODE_STATE_DIR || `./.state/node-${PORT}`;
const PUBLIC_URL = (process.env.NODE_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const VERSION = '0.1.0';

// The node's own identity key signs results; it is separate from the merchant submitter key.
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

async function main() {
  if (!MERCHANT_ID || !PAYOUT || !SUBMITTER_KEY) throw new Error('set MERCHANT_ID, PAYOUT_ADDRESS and MERCHANT_PRIVATE_KEY');
  const identity = loadIdentity();
  const context = await loadX402Context(AP4M_API_URL);
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
  const submitter = new ethers.Wallet(SUBMITTER_KEY, provider);
  const priceWei = ethers.parseUnits(PRICE_RLUSD, 18).toString();

  // Jobs are persisted so a restart never orphans a job the buyer already paid for.
  const jobsDb = new DatabaseSync(join(STATE_DIR, 'jobs.sqlite'));
  jobsDb.exec('CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT');
  const getJob = (id) => { const row = jobsDb.prepare('SELECT spec FROM jobs WHERE job_id=?').get(id); return row ? JSON.parse(String(row.spec)) : undefined; };
  const countJobs = () => Number(jobsDb.prepare('SELECT count(*) AS n FROM jobs').get().n);
  let graded = 0;
  let running = 0;

  const x402 = createX402Resources({
    context, provider, submitter, stateDirectory: STATE_DIR, merchantParticipantId: MERCHANT_ID, payout: PAYOUT,
    resolve(url) {
      const m = url.match(/^(.*)\/grade\/(j_[a-z0-9]{8,40})$/);
      if (!m || m[1] !== PUBLIC_URL) return undefined;
      const job = getJob(m[2]);
      if (!job) return undefined;
      return {
        amount: priceWei,
        async produce({ transactionHash }) {
          running++;
          try {
            const t0 = Date.now();
            const result = CHEAT ? fakeResult(job) : await runJob(job);
            const hash = resultHash(result);
            const sig = await identity.signMessage(resultSigningMessage(job.job_id, hash));
            graded++;
            console.log(`[grade] ${job.job_id} ${result.status} reward=${result.reward} hash=${hash.slice(0, 12)} ${Date.now() - t0}ms paid=${transactionHash.slice(0, 12)}${CHEAT ? ' (CHEAT)' : ''}`);
            return { result, result_hash: hash, sig, provider: identity.address, paid_tx: transactionHash };
          } finally { running--; }
        },
      };
    },
  });

  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    const url = new URL(req.url, PUBLIC_URL);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, running, graded, jobs_known: countJobs() });
    if (req.method === 'GET' && url.pathname === '/info') {
      return send(res, 200, { provider: identity.address, price_rlusd: PRICE_RLUSD, price_wei: priceWei, payout: PAYOUT, merchant_id: MERCHANT_ID, image: SANDBOX_IMAGE, version: VERSION, endpoint: PUBLIC_URL });
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
    console.log(`[node] ${identity.address} selling grades at ${PUBLIC_URL}/grade/{job_id} for ${PRICE_RLUSD} RLUSD${CHEAT ? '  ** CHEAT MODE **' : ''}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); x402.close().finally(() => process.exit(0)); });
}

main().catch((error) => { console.error(error.message ?? error); process.exit(1); });
