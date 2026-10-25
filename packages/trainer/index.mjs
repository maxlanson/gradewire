// Gradewire trainer agent: the paying customer. Picks providers from the coordinator by
// price and reliability, opens one AP4M Channel per provider, pays per grade over x402,
// verifies every signed result, and holds the next payment to a provider until its last
// sampled job has a verdict. A failed verdict bans the provider and reroutes its work.
//
// Usage: node --env-file=.env packages/trainer/index.mjs [--jobs 8] [--node http://127.0.0.1:4401]
// Env: AGENT_PRIVATE_KEY, AP4M_API_URL, TEAM_NAME, COORDINATOR_URL, CHANNEL_ID (an open
// Channel to reuse for the first provider), CHANNEL_CAP (cap for new Channels, default 0.5).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { buyResource, loadX402Context } from '../ap4m/ap4m-x402.mjs';
import { contracts, loadDeployment, rpcUrl } from '../shared/chain.mjs';
import { JOB_KIND, parseJob, resultHash, resultSigningMessage, SANDBOX_IMAGE, specHash } from '../shared/index.mjs';
import { ROLLOUTS } from '../../tasks/rollouts.mjs';

const sdk = createRequire(import.meta.url)('../ap4m/ap4m-hackathon-sdk.cjs');

const { values: args } = parseArgs({ options: {
  coordinator: { type: 'string', default: process.env.COORDINATOR_URL || 'http://127.0.0.1:4500' },
  node: { type: 'string' },
  jobs: { type: 'string', default: '8' },
  'max-price': { type: 'string', default: '0.01' },
  'min-score': { type: 'string', default: '0.8' },
  'no-settle': { type: 'boolean', default: false },
} });
const AP4M_API_URL = (process.env.AP4M_API_URL || 'https://hackathon.ap4m.build').replace(/\/$/, '');
const TEAM_NAME = process.env.TEAM_NAME || 'FranksDAO';
const STATE_ROOT = process.env.TRAINER_STATE_DIR || './.state/trainer';
const CHANNELS_FILE = `${STATE_ROOT}/channels.json`;
const COORD = args.coordinator.replace(/\/$/, '');
const VERDICT_WAIT_MS = 150_000;

const log = (tag, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${tag.padEnd(10)} ${msg}`);

// The AP4M service occasionally answers with an HTML error page; retry those calls.
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (error) {
      if (i >= attempts) throw error;
      log('[retry]', `${label}: ${String(error.shortMessage ?? error.message).slice(0, 90)} (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}
async function getJson(url) { const res = await fetch(url); const data = await res.json(); if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error}`); return data; }
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${url} returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error ?? text.slice(0, 200)}`);
  return data;
}
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return fallback; } };
const makeJob = (rollout) => parseJob({ job_id: `j_${randomBytes(8).toString('hex')}`, kind: JOB_KIND, image: SANDBOX_IMAGE, timeout_s: 20, files: rollout.files, reward_rule: 'fraction_passed', max_price: args['max-price'] });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function main() {
  if (!process.env.AGENT_PRIVATE_KEY) throw new Error('set AGENT_PRIVATE_KEY');
  mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const deployment = loadDeployment();
  const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  const context = await loadX402Context(AP4M_API_URL);
  const { rlusd } = contracts(provider, deployment);
  const explorer = config.network.explorerUrl;
  const maxPriceWei = ethers.parseUnits(args['max-price'], 18);
  const startBalance = await rlusd.balanceOf(wallet.address);
  log('[trainer]', `agent ${wallet.address} holds ${ethers.formatUnits(startBalance, 18)} RLUSD; coordinator ${COORD}`);

  // ── choose providers: coordinator ranking by price / score, or one node directly ──
  let providers;
  if (args.node) {
    const info = await getJson(`${args.node.replace(/\/$/, '')}/info`);
    providers = [{ address: info.provider.toLowerCase(), endpoint: info.endpoint, label: info.label, price_wei: info.price_wei, score: 1 }];
  } else {
    const listed = (await getJson(`${COORD}/providers?min_score=${args['min-score']}&status=active`)).providers;
    providers = [];
    for (const p of listed) {
      try {
        const info = await getJson(`${p.endpoint}/info`);
        if (info.provider.toLowerCase() !== p.address) { log('[trainer]', `skip ${p.endpoint}: identity mismatch`); continue; }
        if (BigInt(info.price_wei) > maxPriceWei) { log('[trainer]', `skip ${p.label}: price ${info.price_rlusd} above max`); continue; }
        providers.push({ address: p.address, endpoint: p.endpoint, label: p.label || info.label, price_wei: info.price_wei, score: p.score, sampling_rate: p.sampling_rate });
      } catch (e) { log('[trainer]', `skip ${p.endpoint}: ${e.message}`); }
    }
  }
  if (!providers.length) throw new Error('no eligible providers');
  for (const p of providers) log('[trainer]', `provider ${p.label} ${short(p.address)} score ${p.score} price ${ethers.formatUnits(p.price_wei, 18)} RLUSD sampling ${p.sampling_rate ?? '-'}`);

  // ── one Channel per provider (each Channel has its own cumulative Voucher counter) ──
  const { token } = await withRetry('signIn', () => sdk.signIn(AP4M_API_URL, TEAM_NAME, wallet));
  const channels = readJson(CHANNELS_FILE, {});
  const spare = process.env.CHANNEL_ID && !Object.values(channels).includes(process.env.CHANNEL_ID) ? process.env.CHANNEL_ID : null;
  const usable = async (id) => { try { const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, id); return s.status === 1 && s.cap - s.redeemed >= maxPriceWei * 2n; } catch { return false; } };
  for (const p of providers) {
    if (channels[p.address] && await usable(channels[p.address])) { p.channelId = channels[p.address]; continue; }
    if (spare && await usable(spare) && !Object.values(channels).includes(spare)) { p.channelId = spare; }
    else {
      const cap = process.env.CHANNEL_CAP || '0.5';
      log('[trainer]', `opening a ${cap} RLUSD Channel for ${p.label}`);
      p.channelId = (await withRetry('requestChannel', () => sdk.requestChannel(AP4M_API_URL, token, wallet, { capRlusd: cap }), 2)).channel_id;
    }
    channels[p.address] = p.channelId;
    writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 1));
  }
  for (const p of providers) {
    const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, p.channelId);
    log('[trainer]', `${p.label}: channel ${short(p.channelId)} cap ${ethers.formatUnits(s.cap, 18)} spent ${ethers.formatUnits(s.redeemed, 18)} RLUSD`);
  }

  // ── work queue and per-provider workers ──
  const queue = ROLLOUTS.slice(0, Math.min(Number(args.jobs), ROLLOUTS.length)).map((r) => ({ rollout: r.id, files: r.files, attempts: 0 }));
  const done = [];
  const banned = new Set();
  const events = [];

  async function purchaseGrade(p, item) {
    const { job, offer } = item;
    const t0 = Date.now();
    const operation = `grade-${job.job_id.slice(2)}`;
    const inflightFile = `${STATE_ROOT}/inflight-${p.address}.json`;
    writeFileSync(inflightFile, JSON.stringify(item));
    // buyResource retains the signed Voucher before sending it, so resuming with the same
    // arguments never pays twice; a 503 from the node means "retry this same payment".
    const purchase = await withRetry(`purchase ${job.job_id}`, () => buyResource({
      context, provider, wallet, stateDirectory: `${STATE_ROOT}/${operation}`, resourceUrl: offer.resource_url,
      channelId: item.channelId, maximumAmount: offer.price_wei, operation,
    }), 6);
    const { result, result_hash, sig, provider: signer } = purchase.resource;
    // Verify what we paid for: spec matches, hash matches, signed by the provider we chose.
    if (result.spec_hash !== specHash(job)) throw new Error(`${job.job_id}: provider graded a different spec`);
    if (resultHash(result) !== result_hash) throw new Error(`${job.job_id}: result hash mismatch`);
    if (ethers.verifyMessage(resultSigningMessage(job.job_id, result_hash), sig).toLowerCase() !== p.address || signer.toLowerCase() !== p.address) throw new Error(`${job.job_id}: result not signed by provider`);
    log(`[${p.label}]`, `paid ${ethers.formatUnits(offer.price_wei, 18)} RLUSD for ${item.rollout.padEnd(18)} reward ${String(result.reward).padEnd(8)} ${Date.now() - t0}ms  ${explorer}/tx/${purchase.transactionHash}`);
    withRetry('record-redemption', () => postJson(`${AP4M_API_URL}/public/participant/record-redemption`, { tx_hash: purchase.transactionHash }, { Authorization: `Bearer ${token}` })).catch((e) => log('[trainer]', `record-redemption: ${e.message}`));
    unlinkSync(inflightFile);
    return { rollout: item.rollout, job_id: job.job_id, provider: p.label, reward: result.reward, tx: purchase.transactionHash };
  }

  // Payment gating: nothing more is paid to a provider while its last sampled job is unverified.
  async function awaitVerdict(p, jobId) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = await getJson(`${COORD}/jobs/${jobId}/verdict`); } catch { v = { verdict: 'pending' }; }
      if (v.verdict !== 'pending') return v;
      if (Date.now() - t0 > VERDICT_WAIT_MS) return { verdict: 'timeout' };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function worker(p) {
    const tag = `[${p.label}]`;
    const inflightFile = `${STATE_ROOT}/inflight-${p.address}.json`;
    let item = existsSync(inflightFile) ? readJson(inflightFile, null) : null;
    if (item) log(tag, `resuming unfinished purchase ${item.job.job_id}`);
    for (;;) {
      if (!item) {
        const next = queue.shift();
        if (!next) return;
        const job = makeJob(next);
        let offer;
        try { offer = await postJson(`${p.endpoint}/jobs`, job); } catch (e) { log(tag, `unreachable (${e.message}); rerouting`); queue.unshift(next); return; }
        item = { job, offer, rollout: next.rollout, files: next.files, attempts: next.attempts + 1, channelId: p.channelId };
      }
      let paid;
      try { paid = await purchaseGrade(p, item); } catch (e) {
        log(tag, `payment/grade failed: ${e.message}; rerouting job`);
        try { unlinkSync(inflightFile); } catch {}
        queue.unshift({ rollout: item.rollout, files: item.files, attempts: item.attempts });
        return;
      }
      const current = item; item = null;
      const verdict = await awaitVerdict(p, current.job.job_id);
      if (verdict.verdict === 'pass') log(tag, `✓ ${current.rollout} verified on-chain (task ${verdict.task_id})  ${explorer}/tx/${verdict.verdict_tx}`);
      else if (verdict.verdict === 'not_sampled') log(tag, `· ${current.rollout} not sampled; paying for the next job`);
      else if (verdict.verdict === 'fail') {
        log(tag, `✗ ${current.rollout} FAILED verification: the grade did not reproduce. Stopping all payments to ${p.label}. ${explorer}/tx/${verdict.verdict_tx}`);
        banned.add(p.address);
        events.push({ kind: 'fraud', provider: p.label, job_id: current.job.job_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx });
        queue.unshift({ rollout: current.rollout, files: current.files, attempts: current.attempts }); // re-grade elsewhere
        return;
      } else log(tag, `? ${current.rollout} verdict ${verdict.verdict}; continuing`);
      done.push({ ...paid, verdict: verdict.verdict });
    }
  }

  await Promise.all(providers.map(worker));
  // Rerouted work: if any queue items remain, run the honest providers again.
  while (queue.length && providers.some((p) => !banned.has(p.address))) {
    await Promise.all(providers.filter((p) => !banned.has(p.address)).map(worker));
  }

  // ── summary ──
  const rewards = done.map((d) => d.reward);
  const mean = rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0;
  console.log('\nrollout              provider    reward   verdict      tx');
  for (const d of done) console.log(`${d.rollout.padEnd(20)} ${d.provider.padEnd(11)} ${String(d.reward).padEnd(8)} ${d.verdict.padEnd(12)} ${d.tx}`);
  log('[trainer]', `${done.length} accepted grades, mean reward ${mean.toFixed(3)}; ${queue.length} jobs left unassigned`);
  for (const e of events) log('[trainer]', `fraud: ${e.provider} banned after ${e.job_id}; slash tx ${e.slash_tx ? `${explorer}/tx/${e.slash_tx}` : 'pending'}`);
  const endBalance = await rlusd.balanceOf(wallet.address);
  if (endBalance !== startBalance) log('[trainer]', `agent RLUSD balance ${ethers.formatUnits(startBalance, 18)} → ${ethers.formatUnits(endBalance, 18)} (refund from slashed bond: +${ethers.formatUnits(endBalance - startBalance, 18)})`);

  if (!args['no-settle']) {
    for (const p of providers) {
      try {
        const settled = await withRetry(`settle ${p.label}`, () => sdk.settle(AP4M_API_URL, token, p.channelId));
        log('[settled]', `${p.label}: ${settled.claims_settled} claims, latest ${settled.amount_rlusd} RLUSD to ${settled.recipient}  ${explorer}/tx/${settled.payout_tx}`);
        if (settled.receipt_url) log('[receipt]', `${AP4M_API_URL}${settled.receipt_url}`);
      } catch (e) { log('[settle]', `${p.label}: ${e.message} (the service settles automatically later)`); }
    }
  }
}

main().catch((error) => { console.error(error.shortMessage ?? error.message ?? error); process.exit(1); });
