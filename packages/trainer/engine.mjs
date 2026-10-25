// Gradewire paying client, shared by the RL trainer (packages/trainer/index.mjs) and the
// "ask" CLI (packages/ask/index.mjs). It picks providers from the coordinator by price and
// reliability, keeps a pool of AP4M Channels (one per provider), pays per job over x402 with
// resume-on-crash, verifies every signed result, and holds the next payment to a provider
// until its last sampled job has a verdict. A failed verdict bans the provider and reroutes
// its work. Optionally settles and closes Channels at the end.
//
// Env: AGENT_PRIVATE_KEY, AP4M_API_URL, TEAM_NAME, CHANNEL_ID (an open Channel to reuse for
// the first provider), CHANNEL_CAP (cap for new Channels, default 0.5), TRAINER_STATE_DIR.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { ethers } from 'ethers';

import { buyResource, loadX402Context } from '../ap4m/ap4m-x402.mjs';
import { describeError, contracts, loadDeployment, rpcUrl } from '../shared/chain.mjs';
import { resultHash, resultSigningMessage, specHash } from '../shared/index.mjs';

const sdk = createRequire(import.meta.url)('../ap4m/ap4m-hackathon-sdk.cjs');

const VERDICT_WAIT_MS = 150_000;

export const defaultLog = (tag, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${tag.padEnd(10)} ${msg}`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The AP4M service occasionally answers with an HTML error page; retry those calls.
export async function withRetry(label, fn, attempts = 4, log = defaultLog) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (error) {
      if (i >= attempts) throw error;
      log('[retry]', `${label}: ${String(describeError(error)).slice(0, 90)} (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}
export async function getJson(url) { const res = await fetch(url); const data = await res.json(); if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error}`); return data; }
export async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${url} returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error ?? text.slice(0, 200)}`);
  return data;
}
const writeJson = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1)); renameSync(`${file}.tmp`, file); };

/**
 * Pay for and collect one job per item, in parallel across providers.
 *
 * @param {{
 *   items: Array<{ id: string, files: Array<{path: string, content: string}> }>,  work to buy, in order
 *   buildJob: (item) => object,          returns a parsed job (packages/shared parseJob) with a fresh job_id
 *   maxPrice: string,                    highest price per job in RLUSD, e.g. '0.01'
 *   minScore?: string|number,            coordinator reliability floor (default '0.8')
 *   node?: string,                       one node URL to use instead of the coordinator ranking
 *   coordinator?: string,                coordinator URL (default COORDINATOR_URL or http://127.0.0.1:4500)
 *   settle?: boolean,                    settle every Channel and close banned ones at the end (default true)
 *   log?: (tag: string, msg: string) => void,
 *   onEvent?: (event: object) => void|Promise<void>,   see the `emit` calls below for event shapes
 *   stateRoot?: string,                  default TRAINER_STATE_DIR or ./.state/trainer
 *   agentTag?: string,                   tag for the client's own log lines (default '[trainer]')
 * }} options
 * @returns {Promise<{
 *   results: Array<{ id, job_id, provider, provider_address, price_wei, tx, status, reward, result, verdict, task_id, verdict_tx }>,
 *   unassigned: Array<{ id, files, attempts }>, events: Array<object>, providers: Array<object>,
 *   startBalance: bigint, endBalance: bigint, explorer: string, settlements: Array<object>,
 * }>}
 */
export async function runPaidJobs({ items, buildJob, maxPrice, minScore = '0.8', node, coordinator, settle = true, log = defaultLog, onEvent, stateRoot, agentTag = '[trainer]' }) {
  if (!process.env.AGENT_PRIVATE_KEY) throw new Error('set AGENT_PRIVATE_KEY');
  const AP4M_API_URL = (process.env.AP4M_API_URL || 'https://hackathon.ap4m.build').replace(/\/$/, '');
  const TEAM_NAME = process.env.TEAM_NAME || 'FranksDAO';
  const STATE_ROOT = stateRoot || process.env.TRAINER_STATE_DIR || './.state/trainer';
  const CHANNELS_FILE = `${STATE_ROOT}/channels.json`;
  const COORD = (coordinator || process.env.COORDINATOR_URL || 'http://127.0.0.1:4500').replace(/\/$/, '');
  const emit = async (event) => { if (onEvent) await onEvent(event); };
  const retry = (label, fn, attempts) => withRetry(label, fn, attempts, log);
  const readJson = (file, fallback) => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      if (e instanceof SyntaxError) { log(agentTag, `ignoring corrupt ${file}`); return fallback; } // a crash mid-write
      throw e;
    }
  };

  mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const deployment = loadDeployment();
  const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  const context = await loadX402Context(AP4M_API_URL);
  const { rlusd } = contracts(provider, deployment);
  const explorer = config.network.explorerUrl;
  const maxPriceWei = ethers.parseUnits(maxPrice, 18);
  const startBalance = await rlusd.balanceOf(wallet.address);
  log(agentTag, `agent ${wallet.address} holds ${ethers.formatUnits(startBalance, 18)} RLUSD; coordinator ${COORD}`);
  await emit({ type: 'start', agent: wallet.address, balance: startBalance, explorer, coordinator: COORD });

  // ── choose providers: coordinator ranking by price / score, or one node directly ──
  let providers;
  if (node) {
    const info = await getJson(`${node.replace(/\/$/, '')}/info`);
    providers = [{ address: info.provider.toLowerCase(), endpoint: info.endpoint, label: info.label, price_wei: info.price_wei, score: 1 }];
  } else {
    const listed = (await getJson(`${COORD}/providers?min_score=${minScore}&status=active`)).providers;
    providers = [];
    for (const p of listed) {
      try {
        const info = await getJson(`${p.endpoint}/info`);
        if (info.provider.toLowerCase() !== p.address) { log(agentTag, `skip ${p.endpoint}: identity mismatch`); continue; }
        if (BigInt(info.price_wei) > maxPriceWei) { log(agentTag, `skip ${p.label}: price ${info.price_rlusd} above max`); continue; }
        providers.push({ address: p.address, endpoint: p.endpoint, label: p.label || info.label, price_wei: info.price_wei, score: p.score, sampling_rate: p.sampling_rate });
      } catch (e) { log(agentTag, `skip ${p.endpoint}: ${e.message}`); }
    }
  }
  if (!providers.length) throw new Error('no eligible providers');
  for (const p of providers) log(agentTag, `provider ${p.label} ${short(p.address)} score ${p.score} price ${ethers.formatUnits(p.price_wei, 18)} RLUSD sampling ${p.sampling_rate ?? '-'}`);

  // ── one Channel per provider (each Channel has its own cumulative Voucher counter) ──
  const { token } = await retry('signIn', () => sdk.signIn(AP4M_API_URL, TEAM_NAME, wallet));

  // AGENTS.md: resume an unresolved purchase with its original arguments before starting another.
  // buyResource keeps the signed intent in purchase.json, so a Voucher signed on this Channel
  // by an earlier run that crashed or gave up is collected (or confirmed stuck) before new spend.
  async function resumeStranded(channelId) {
    for (const dir of readdirSync(STATE_ROOT, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith('grade-')) continue;
      const retained = readJson(`${STATE_ROOT}/${dir.name}/purchase.json`, null);
      if (!retained || retained.complete || retained.intent?.channelId !== channelId) continue;
      log(agentTag, `resuming unresolved purchase ${retained.intent.operation} on channel ${short(channelId)}`);
      const r = await buyResource({ context, provider, wallet, stateDirectory: `${STATE_ROOT}/${dir.name}`, ...retained.intent });
      retry('record-redemption', () => postJson(`${AP4M_API_URL}/public/participant/record-redemption`, { tx_hash: r.transactionHash }, { Authorization: `Bearer ${token}` })).catch(() => {});
    }
  }

  // The service caps the number of open Channels per payout, so Channels are a pool: keep a
  // grader's Channel across runs, reclaim Channels whose grader is gone (banned, offline),
  // and only open a new one when the pool is empty. A grader we cannot fund is skipped.
  const channels = readJson(CHANNELS_FILE, {});
  const usable = async (id) => { try { const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, id); return s.status === 1 && s.cap - s.redeemed >= maxPriceWei * 2n; } catch { return false; } };
  const current = new Set(providers.map((p) => p.address));
  const pool = [];
  for (const [addr, id] of Object.entries(channels)) if (!current.has(addr)) {
    // Only hand a Channel to a new grader once every payment signed on it has resolved.
    try { await resumeStranded(id); delete channels[addr]; pool.push(id); } catch (e) { log(agentTag, `channel ${short(id)} has an unresolved payment (${String(e.message).slice(0, 60)}); not reusing it`); }
  }
  if (process.env.CHANNEL_ID) pool.push(process.env.CHANNEL_ID);
  for (const c of await sdk.listChannels(AP4M_API_URL, token)) if (c.channel_status === 'open') pool.push(c.channel_id);
  const assigned = new Set(Object.values(channels));
  const funded = [];
  for (const p of providers) {
    if (channels[p.address] && await usable(channels[p.address])) { p.channelId = channels[p.address]; funded.push(p); continue; }
    delete channels[p.address];
    for (const id of pool) { if (!assigned.has(id) && await usable(id)) { p.channelId = id; break; } }
    if (!p.channelId) {
      const cap = process.env.CHANNEL_CAP || '0.5';
      log(agentTag, `opening a ${cap} RLUSD Channel for ${p.label}`);
      try { p.channelId = (await sdk.requestChannel(AP4M_API_URL, token, wallet, { capRlusd: cap })).channel_id; } catch (e) { log(agentTag, `cannot fund ${p.label}: ${String(e.message).slice(0, 90)}; skipping it`); continue; }
    }
    channels[p.address] = p.channelId;
    assigned.add(p.channelId);
    funded.push(p);
    writeJson(CHANNELS_FILE, channels);
  }
  writeJson(CHANNELS_FILE, channels);
  providers = funded;
  if (!providers.length) throw new Error('no provider could be funded with a Channel');
  // Spending limits are visible on the dashboard, not only in this terminal: the agent posts
  // its Channel caps and spend to the coordinator. Spend is tracked locally after each payment
  // (one RPC read per Channel here and once at the end). A failed post never affects payments.
  const budget = new Map(); // provider address -> { cap, spent, status }
  const channelStatus = (n) => (n === 1 ? 'open' : `status ${n}`);
  let budgetPostFailed = false;
  function postBudget() {
    const body = {
      agent: wallet.address,
      channels: providers.map((p) => { const b = budget.get(p.address) ?? {}; return { provider: p.address, label: p.label, channel_id: p.channelId, cap_wei: String(b.cap ?? 0n), spent_wei: String(b.spent ?? 0n), status: b.status ?? 'unknown' }; }),
      max_price_wei: maxPriceWei.toString(),
      min_score: String(minScore),
    };
    return postJson(`${COORD}/agent/budget`, body).catch((e) => { if (!budgetPostFailed) { budgetPostFailed = true; log(agentTag, `budget not posted to the coordinator: ${String(e.message).slice(0, 80)}`); } });
  }
  async function readBudgets() {
    for (const p of providers) {
      try { const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, p.channelId); budget.set(p.address, { cap: s.cap, spent: s.redeemed, status: budget.get(p.address)?.status === 'closed' ? 'closed' : channelStatus(s.status) }); } catch { /* keep the last known values */ }
    }
  }

  for (const p of providers) {
    const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, p.channelId);
    p.channel = { cap: s.cap, redeemed: s.redeemed };
    budget.set(p.address, { cap: s.cap, spent: s.redeemed, status: channelStatus(s.status) });
    log(agentTag, `${p.label}: channel ${short(p.channelId)} cap ${ethers.formatUnits(s.cap, 18)} spent ${ethers.formatUnits(s.redeemed, 18)} RLUSD`);
  }
  await postBudget();
  await emit({ type: 'providers', providers: providers.map((p) => ({ ...p })) });

  // ── work queue and per-provider workers ──
  const queue = items.map((it) => ({ id: it.id, files: it.files, attempts: 0 }));
  const done = [];
  const banned = new Set();
  const paused = new Set(); // not paid again this run: unreachable, stuck payment, or last job unverified
  const events = [];

  async function purchaseGrade(p, item) {
    const { job, offer } = item;
    const t0 = Date.now();
    const operation = `grade-${job.job_id.slice(2)}`;
    const inflightFile = `${STATE_ROOT}/inflight-${p.address}.json`;
    writeJson(inflightFile, item);
    // buyResource retains the signed Voucher before sending it, so resuming with the same
    // arguments never pays twice; a 503 from the node means "retry this same payment".
    const purchase = await retry(`purchase ${job.job_id}`, () => buyResource({
      context, provider, wallet, stateDirectory: `${STATE_ROOT}/${operation}`, resourceUrl: offer.resource_url,
      channelId: item.channelId, maximumAmount: offer.price_wei, operation,
    }), 6);
    const { result, result_hash, sig, provider: signer } = purchase.resource;
    // Verify what we paid for: spec matches, hash matches, signed by the provider we chose.
    if (result.spec_hash !== specHash(job)) throw new Error(`${job.job_id}: provider graded a different spec`);
    if (resultHash(result) !== result_hash) throw new Error(`${job.job_id}: result hash mismatch`);
    if (ethers.verifyMessage(resultSigningMessage(job.job_id, result_hash), sig).toLowerCase() !== p.address || signer.toLowerCase() !== p.address) throw new Error(`${job.job_id}: result not signed by provider`);
    const ms = Date.now() - t0;
    log(`[${p.label}]`, `paid ${ethers.formatUnits(offer.price_wei, 18)} RLUSD for ${item.id.padEnd(18)} reward ${String(result.reward).padEnd(8)} ${ms}ms  ${explorer}/tx/${purchase.transactionHash}`);
    retry('record-redemption', () => postJson(`${AP4M_API_URL}/public/participant/record-redemption`, { tx_hash: purchase.transactionHash }, { Authorization: `Bearer ${token}` })).catch((e) => log(agentTag, `record-redemption: ${e.message}`));
    unlinkSync(inflightFile);
    const paid = { id: item.id, job_id: job.job_id, provider: p.label, provider_address: p.address, price_wei: offer.price_wei, reward: result.reward, status: result.status, tx: purchase.transactionHash, result };
    await emit({ type: 'paid', ...paid, ms, explorer });
    const b = budget.get(p.address);
    if (b) b.spent += BigInt(offer.price_wei);
    postBudget();
    return paid;
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
        try { await resumeStranded(p.channelId); } catch (e) { log(tag, `an earlier payment on this channel is unresolved (${String(e.message).slice(0, 80)}); not paying it this run`); paused.add(p.address); return; }
        const next = queue.shift();
        if (!next) return;
        if (next.attempts >= 3) { log(agentTag, `giving up on ${next.id} after ${next.attempts} attempts`); await emit({ type: 'giveup', id: next.id, attempts: next.attempts }); continue; }
        const job = buildJob(next);
        let offer;
        try { offer = await postJson(`${p.endpoint}/jobs`, job); } catch (e) { log(tag, `unreachable (${e.message}); rerouting`); paused.add(p.address); queue.unshift(next); await emit({ type: 'reroute', id: next.id, provider: p.label, reason: 'unreachable' }); return; }
        item = { job, offer, id: next.id, files: next.files, attempts: next.attempts + 1, channelId: p.channelId };
        await emit({ type: 'dispatch', id: next.id, job_id: job.job_id, provider: p.label, price_wei: offer.price_wei, attempt: item.attempts });
      }
      let paid;
      try { paid = await purchaseGrade(p, item); } catch (e) {
        // The signed Voucher stays on disk (inflight + purchase.json) and is resumed next run.
        log(tag, `payment/grade failed: ${e.message}; rerouting the job and keeping the payment to resume later`);
        paused.add(p.address);
        queue.unshift({ id: item.id, files: item.files, attempts: item.attempts });
        await emit({ type: 'reroute', id: item.id, provider: p.label, reason: `payment/grade failed: ${e.message}` });
        return;
      }
      const current = item; item = null;
      if (paid.status === 'error') {
        log(tag, `sandbox fault at ${p.label} on ${current.id}: grade unusable, not paying ${p.label} again this run; rerouting`);
        paused.add(p.address);
        queue.unshift({ id: current.id, files: current.files, attempts: current.attempts });
        await emit({ type: 'reroute', id: current.id, provider: p.label, reason: 'sandbox fault' });
        return;
      }
      const verdict = await awaitVerdict(p, current.job.job_id);
      const verdictEvent = { type: 'verdict', id: current.id, job_id: current.job.job_id, provider: p.label, provider_address: p.address, verdict: verdict.verdict, task_id: verdict.task_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx, explorer };
      if (verdict.verdict === 'pass') log(tag, `✓ ${current.id} verified on-chain (task ${verdict.task_id})  ${explorer}/tx/${verdict.verdict_tx}`);
      else if (verdict.verdict === 'not_sampled') log(tag, `· ${current.id} not sampled; paying for the next job`);
      else if (verdict.verdict === 'fail') {
        log(tag, `✗ ${current.id} FAILED verification: the grade did not reproduce. Stopping all payments to ${p.label}. ${explorer}/tx/${verdict.verdict_tx}`);
        banned.add(p.address);
        events.push({ kind: 'fraud', provider: p.label, job_id: current.job.job_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx });
        queue.unshift({ id: current.id, files: current.files, attempts: current.attempts }); // re-grade elsewhere
        await emit(verdictEvent);
        await emit({ type: 'fraud', id: current.id, provider: p.label, provider_address: p.address, job_id: current.job.job_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx, explorer });
        return;
      } else {
        // Gating rule: never pay a grader while its last sampled job is unverified.
        log(tag, `? ${current.id} verdict ${verdict.verdict}: last job still unverified, not paying ${p.label} again this run`);
        done.push({ ...paid, verdict: verdict.verdict, task_id: verdict.task_id, verdict_tx: verdict.verdict_tx });
        paused.add(p.address);
        await emit(verdictEvent);
        return;
      }
      done.push({ ...paid, verdict: verdict.verdict, task_id: verdict.task_id, verdict_tx: verdict.verdict_tx });
      await emit(verdictEvent);
    }
  }

  const live = () => providers.filter((p) => !banned.has(p.address) && !paused.has(p.address));
  await Promise.all(providers.map(worker));
  // Rerouted work: while jobs remain and some grader is still payable, run those graders again.
  while (queue.length && live().length) await Promise.all(live().map(worker));

  const endBalance = await rlusd.balanceOf(wallet.address);
  const outcome = { results: done, unassigned: queue, events, providers, banned: [...banned], startBalance, endBalance, explorer, settlements: [] };
  await emit({ type: 'done', ...outcome });

  if (settle) {
    for (const p of providers) {
      try {
        const settled = await retry(`settle ${p.label}`, () => sdk.settle(AP4M_API_URL, token, p.channelId));
        log('[settled]', `${p.label}: ${settled.claims_settled} claims, latest ${settled.amount_rlusd} RLUSD to ${settled.recipient}  ${explorer}/tx/${settled.payout_tx}`);
        if (settled.receipt_url) log('[receipt]', `${AP4M_API_URL}${settled.receipt_url}`);
        outcome.settlements.push({ provider: p.label, ...settled, receipt_url: settled.receipt_url ? `${AP4M_API_URL}${settled.receipt_url}` : null });
        await emit({ type: 'settled', provider: p.label, ...settled, explorer });
      } catch (e) { log('[settle]', `${p.label}: ${e.message} (the service settles automatically later)`); }
    }
    // A banned grader never gets paid again: close its Channel to free the slot and the budget.
    for (const p of providers.filter((x) => banned.has(x.address))) {
      try {
        const closed = await retry(`close ${p.label}`, () => sdk.closeChannel(AP4M_API_URL, token, wallet, p.channelId), 2);
        delete channels[p.address];
        writeJson(CHANNELS_FILE, channels);
        log('[closed]', `${p.label}'s Channel closed  ${explorer}/tx/${closed.tx_hash}`);
        const b = budget.get(p.address);
        if (b) b.status = 'closed';
        await emit({ type: 'closed', provider: p.label, tx: closed.tx_hash, explorer });
      } catch (e) { log('[close]', `${p.label}: ${e.message}`); }
    }
  }
  await readBudgets();
  await postBudget();
  return outcome;
}
