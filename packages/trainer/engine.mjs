// Gradewire paying client, shared by the RL trainer (packages/trainer/index.mjs) and the
// "ask" CLI (packages/ask/index.mjs). It picks providers from the coordinator by price and
// reliability, keeps a pool of AP4M Channels (one per provider), pays per job over x402 with
// resume-on-crash, verifies every signed result, and lets each provider hold only as many
// unverified jobs as the trust it has earned (one for a new node, one more per clean check,
// up to three). A failed verdict bans the provider, discards its unverified results and
// reroutes them. Optionally settles and closes Channels at the end.
//
// Env: AGENT_PRIVATE_KEY, AP4M_API_URL, TEAM_NAME, CHANNEL_ID (an open Channel to reuse for
// the first provider), CHANNEL_CAP (cap for new Channels, default 0.5), TRAINER_STATE_DIR.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { ethers } from 'ethers';

import { buyResource, loadX402Context } from '../ap4m/ap4m-x402.mjs';
import { contracts, describeError, loadDeployment, makeProvider } from '../shared/chain.mjs';
import { resultHash, resultSigningMessage, specHash } from '../shared/index.mjs';
import { describeTrust } from '../shared/trust.mjs';

const sdk = createRequire(import.meta.url)('../ap4m/ap4m-hackathon-sdk.cjs');

const VERDICT_WAIT_MS = 150_000;
// A node's /grade call covers its on-chain redemption (12-25 s) and the job's run (up to 45 s),
// so a healthy call can take 70 s; anything past this is a node that went away mid-job.
const NODE_REQUEST_TIMEOUT_MS = 100_000; // redemption (12-25 s) + a job of up to 45 s, with margin
const UNREACHABLE = /fetch failed|ECONN|ENOTFOUND|EHOSTUNREACH|socket hang up|timed? ?out|aborted|AbortError|\b5(02|04|2[0-9]|3[0-9])\b/i; // 503 is a live node declining, not a dead one
const nodeFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(NODE_REQUEST_TIMEOUT_MS) });

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
export async function postJson(url, body, headers = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
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
  const provider = makeProvider(deployment); // chunked getLogs + rate-limit backoff on Quicknode
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
        providers.push({ address: p.address, endpoint: p.endpoint, label: p.label || info.label, price_wei: info.price_wei, score: p.score, sampling_rate: p.sampling_rate, trust: p.trust });
      } catch (e) { log(agentTag, `skip ${p.endpoint}: ${e.message}`); }
    }
  }
  if (!providers.length) throw new Error('no eligible providers');
  for (const p of providers) log(agentTag, `provider ${p.label} ${short(p.address)} score ${p.score} price ${ethers.formatUnits(p.price_wei, 18)} RLUSD · ${describeTrust(p.trust)}`);

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
      try {
        const r = await buyResource({ context, provider, wallet, stateDirectory: `${STATE_ROOT}/${dir.name}`, ...retained.intent, requestFetch: nodeFetch });
        retry('record-redemption', () => postJson(`${AP4M_API_URL}/public/participant/record-redemption`, { tx_hash: r.transactionHash }, { Authorization: `Bearer ${token}` })).catch(() => {});
      } catch (error) {
        // A Voucher the node never redeemed (no transaction on record) and now refuses, because its
        // challenge expired while the node was down, can never complete: set it aside so the Channel
        // is usable again. A Voucher that was redeemed is always retried (the result is owed).
        const ageMin = (Date.now() - statSync(`${STATE_ROOT}/${dir.name}/purchase.json`).mtimeMs) / 60_000;
        const refused = /(400|409|503|outcome unavailable|retained|acceptance_closed|invalid_payment)/i.test(describeError(error));
        if (!retained.transactionHash && refused) {
          renameSync(`${STATE_ROOT}/${dir.name}`, `${STATE_ROOT}/abandoned-${dir.name}`);
          log(agentTag, `set aside stale purchase ${retained.intent.operation} (${ageMin.toFixed(0)} min old, never redeemed, node refuses it); channel ${short(channelId)} is usable again`);
          continue;
        }
        throw error;
      }
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
      try { const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, p.channelId); budget.set(p.address, { cap: s.cap, spent: s.redeemed, status: ['closed', 'stopped'].includes(budget.get(p.address)?.status) ? budget.get(p.address).status : channelStatus(s.status) }); } catch { /* keep the last known values */ }
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
  const pausedWhy = new Map(); // address -> reason; an 'unreachable' node may rejoin once the coordinator sees it online again
  const pausedAt = new Map(); // address -> when; a rejoin needs a heartbeat newer than this
  const holding = new Map(); // address -> item id a worker is currently paying for / awaiting; a part is never queued while another worker holds it
  const events = [];

  async function purchaseGrade(p, item) {
    const { job, offer } = item;
    const t0 = Date.now();
    const operation = `grade-${job.job_id.slice(2)}`;
    const inflightFile = `${STATE_ROOT}/inflight-${p.address}.json`;
    writeJson(inflightFile, item);
    // buyResource retains the signed Voucher before sending it, so resuming with the same
    // arguments never pays twice; a 503 from the node means "retry this same payment".
    // Service hiccups are retried up to 6 times; a node that stops answering (closed laptop,
    // dead tunnel) gets two tries and is then rerouted, so an unreliable node costs seconds, not minutes.
    let purchase;
    for (let attempt = 1; ; attempt++) {
      try {
        purchase = await buyResource({
          context, provider, wallet, stateDirectory: `${STATE_ROOT}/${operation}`, resourceUrl: offer.resource_url,
          channelId: item.channelId, maximumAmount: offer.price_wei, operation, requestFetch: nodeFetch,
        });
        break;
      } catch (error) {
        const unreachable = UNREACHABLE.test(String(describeError(error)));
        if (attempt >= (unreachable ? 2 : 6)) throw new Error(`${unreachable ? 'node unreachable' : 'purchase failed'}: ${String(describeError(error)).slice(0, 120)}`);
        log('[retry]', `purchase ${job.job_id}: ${String(describeError(error)).slice(0, 90)} (attempt ${attempt + 1}/${unreachable ? 2 : 6})`);
        await new Promise((r) => setTimeout(r, (unreachable ? 1 : attempt) * 3000));
      }
    }
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

  // One worker per provider. Payments to a provider are sequential (its Channel has one
  // cumulative Voucher counter), but the worker does not wait for each verdict before paying
  // for the next job: it may hold up to `allowed` unverified jobs, where `allowed` is the
  // trust the coordinator reports for that node (one job for a new node, one more per clean
  // check, up to three). A failed verdict bans the node, discards its unverified results and
  // reroutes them; an unresolved verdict pauses it for the rest of the run.
  async function worker(p) {
    const tag = `[${p.label}]`;
    const inflightFile = `${STATE_ROOT}/inflight-${p.address}.json`;
    let item = existsSync(inflightFile) ? readJson(inflightFile, null) : null;
    // A purchase left behind by a crashed run is settled first so the signed Voucher is not
    // lost, but its result belongs to that run's question, so it is not used for this one.
    if (item) { item.resumed = true; log(tag, `settling an unfinished purchase from an earlier run (${item.job.job_id}); its result is not used here`); }
    const pending = new Map(); // job_id -> promise that resolves once its verdict is handled
    let allowed = Math.max(1, p.trust?.max_inflight ?? 1);
    let stop = false;

    const applyTrust = async (t) => {
      if (!t || banned.has(p.address)) return;
      const next = Math.max(1, t.max_inflight);
      if (next === allowed) return;
      const previous = allowed;
      allowed = next;
      p.trust = t;
      log(tag, `trust ${next > previous ? 'up' : 'down'}: ${describeTrust(t)} (${t.clean_checks} clean check${t.clean_checks === 1 ? '' : 's'})`);
      await emit({ type: 'trust', provider: p.label, provider_address: p.address, previous_inflight: previous, ...t });
    };
    const requeue = (r) => {
      const heldElsewhere = [...holding.entries()].some(([addr, id]) => id === r.id && addr !== p.address);
      const settled = done.some((d) => d.id === r.id && (d.verdict === 'pass' || d.verdict === 'not_sampled'));
      if (!queue.some((q) => q.id === r.id) && !heldElsewhere && !settled) queue.unshift({ id: r.id, files: r.files, attempts: r.attempts });
    };

    const settleJob = async (current, paid) => {
      try {
        const verdict = await awaitVerdict(p, current.job.job_id);
        const verdictEvent = { type: 'verdict', id: current.id, job_id: current.job.job_id, provider: p.label, provider_address: p.address, verdict: verdict.verdict, task_id: verdict.task_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx, explorer };
        const record = { ...paid, verdict: verdict.verdict, task_id: verdict.task_id, verdict_tx: verdict.verdict_tx, files: current.files, attempts: current.attempts };
        if (verdict.verdict === 'pass') {
          log(tag, `✓ ${current.id} verified on-chain (task ${verdict.task_id})  ${explorer}/tx/${verdict.verdict_tx}`);
          done.push(record);
          await emit(verdictEvent);
          await applyTrust(verdict.trust);
        } else if (verdict.verdict === 'not_sampled') {
          if (banned.has(p.address)) {
            log(tag, `· ${current.id} was not sampled and ${p.label} has since been caught cheating: discarding it and rerouting`);
            requeue(current);
            await emit({ type: 'reroute', id: current.id, provider: p.label, reason: 'unverified result from a node caught cheating' });
          } else {
            log(tag, `· ${current.id} not sampled; result accepted`);
            done.push(record);
            await emit(verdictEvent);
            await applyTrust(verdict.trust);
          }
        } else if (verdict.verdict === 'fail') {
          log(tag, `✗ ${current.id} FAILED verification: the result did not reproduce. Stopping all payments to ${p.label}. ${explorer}/tx/${verdict.verdict_tx}`);
          banned.add(p.address);
          stop = true;
          { const b = budget.get(p.address); if (b) b.status = 'stopped'; postBudget(); } // the dashboard shows this Channel as stopped
          events.push({ kind: 'fraud', provider: p.label, job_id: current.job.job_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx });
          requeue(current); // re-run elsewhere
          // Results this node delivered that were never re-run are no longer trusted either.
          for (let i = done.length - 1; i >= 0; i--) {
            const r = done[i];
            if (r.provider_address !== p.address || r.verdict !== 'not_sampled') continue;
            done.splice(i, 1);
            requeue(r);
            log(tag, `· discarding ${r.id}: unverified result from a node caught cheating; rerouting`);
            await emit({ type: 'reroute', id: r.id, provider: p.label, reason: 'unverified result from a node caught cheating' });
          }
          await emit(verdictEvent);
          await emit({ type: 'fraud', id: current.id, provider: p.label, provider_address: p.address, job_id: current.job.job_id, verdict_tx: verdict.verdict_tx, slash_tx: verdict.slash_tx, explorer });
        } else {
          // Gating rule: never pay a node while one of its sampled jobs is unverified.
          log(tag, `? ${current.id} verdict ${verdict.verdict}: still unverified, not paying ${p.label} again this run`);
          done.push(record);
          paused.add(p.address);
          stop = true;
          await emit(verdictEvent);
        }
      } catch (e) {
        log(tag, `verdict handling for ${current.id} failed: ${describeError(e)}; not paying ${p.label} again this run`);
        paused.add(p.address);
        stop = true;
      } finally {
        pending.delete(current.job.job_id);
      }
    };

    for (;;) {
      while (pending.size >= allowed && !stop) await Promise.race(pending.values());
      if (stop) break;
      if (!item) {
        try { await resumeStranded(p.channelId); } catch (e) { log(tag, `an earlier payment on this channel is unresolved (${String(e.message).slice(0, 80)}); not paying it this run`); paused.add(p.address); break; }
        const next = queue.shift();
        if (!next) break;
        holding.set(p.address, next.id);
        if (next.attempts >= 3) { holding.delete(p.address); log(agentTag, `giving up on ${next.id} after ${next.attempts} attempts`); await emit({ type: 'giveup', id: next.id, attempts: next.attempts }); continue; }
        const job = buildJob(next);
        let offer;
        try { offer = await postJson(`${p.endpoint}/jobs`, job, {}, nodeFetch); } catch (e) { log(tag, `unreachable (${e.message}); rerouting`); paused.add(p.address); pausedWhy.set(p.address, 'unreachable'); pausedAt.set(p.address, Date.now()); requeue(next); await emit({ type: 'reroute', id: next.id, provider: p.label, reason: 'unreachable' }); break; }
        item = { job, offer, id: next.id, files: next.files, attempts: next.attempts + 1, channelId: p.channelId };
        await emit({ type: 'dispatch', id: next.id, job_id: job.job_id, provider: p.label, price_wei: offer.price_wei, attempt: item.attempts, inflight: pending.size + 1, allowed });
      }
      let paid;
      try { paid = await purchaseGrade(p, item); } catch (e) {
        // The signed Voucher stays on disk (inflight + purchase.json) and is resumed next run.
        log(tag, `payment/grade failed: ${e.message}; rerouting the job and keeping the payment to resume later`);
        paused.add(p.address);
        if (/unreachable/.test(String(e.message))) { pausedWhy.set(p.address, 'unreachable'); pausedAt.set(p.address, Date.now()); }
        if (existsSync(inflightFile)) unlinkSync(inflightFile); // the signed Voucher, if any, lives in the purchase state and is resumed via resumeStranded
        requeue({ id: item.id, files: item.files, attempts: item.attempts });
        await emit({ type: 'reroute', id: item.id, provider: p.label, reason: `payment/grade failed: ${e.message}` });
        break;
      }
      const current = item; item = null;
      if (current.resumed) { log(tag, `settled ${current.job.job_id} from the earlier run`); continue; }
      if (paid.status === 'error') {
        log(tag, `sandbox fault at ${p.label} on ${current.id}: result unusable, not paying ${p.label} again this run; rerouting`);
        paused.add(p.address);
        requeue({ id: current.id, files: current.files, attempts: current.attempts });
        await emit({ type: 'reroute', id: current.id, provider: p.label, reason: 'sandbox fault' });
        break;
      }
      pending.set(current.job.job_id, settleJob(current, paid).finally(() => { if (holding.get(p.address) === current.id) holding.delete(p.address); }));
    }
    holding.delete(p.address);
    await Promise.all(pending.values()); // every paid job of this node gets its verdict before the run moves on
  }

  const live = () => providers.filter((p) => !banned.has(p.address) && !paused.has(p.address));
  const active = new Map(); // address -> running worker promise
  const launch = (p) => { const pr = worker(p).catch((e) => log(`[${p.label}]`, `worker failed: ${describeError(e)}`)).finally(() => active.delete(p.address)); active.set(p.address, pr); };
  for (const p of live()) launch(p);
  // A node that went unreachable mid-run (laptop closed, VM stopped) is paused, not banned. While
  // work remains, ask the coordinator every 5 s whether it is back online; if so, let it rejoin
  // with whatever trust it has left (the coordinator restarts its clean streak: one job at a time).
  const returner = setInterval(async () => {
    if (!queue.length) return;
    const back = providers.filter((p) => pausedWhy.get(p.address) === 'unreachable');
    if (!back.length) return;
    let list;
    try { list = (await getJson(`${COORD}/providers?status=active&min_score=${minScore}`)).providers; } catch { return; }
    for (const p of back) {
      const now = list.find((x) => x.address.toLowerCase() === p.address && x.online !== false && Number(x.last_seen || 0) > (pausedAt.get(p.address) || 0) + 5000);
      if (!now) continue; // no heartbeat since it dropped: still gone
      paused.delete(p.address); pausedWhy.delete(p.address);
      p.trust = now.trust; p.score = now.score;
      log(`[${p.label}]`, `back online (score ${now.score}, ${describeTrust(now.trust)}); giving it work again`);
      await emit({ type: 'return', provider: p.label, provider_address: p.address, score: now.score, trust: now.trust });
      if (!active.has(p.address)) launch(p);
    }
  }, 5000);
  // Keep workers running while jobs remain: a rerouted job or a returning node may need a worker that
  // already exited. If work remains and the only candidates are nodes that dropped mid-run, wait up to
  // 90 s for one of them to come back before giving the parts up.
  const waitStart = Date.now();
  for (;;) {
    while (active.size) {
      await Promise.race(active.values());
      if (queue.length) for (const p of live()) if (!active.has(p.address)) launch(p);
    }
    const mayReturn = providers.some((p) => pausedWhy.get(p.address) === 'unreachable');
    if (!queue.length || !mayReturn || Date.now() - waitStart > 90_000) break;
    if (!active.size) log(agentTag, `${queue.length} part${queue.length === 1 ? '' : 's'} left and only a dropped node could take them; waiting for it to come back`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  clearInterval(returner);

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
