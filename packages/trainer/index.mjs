// Gradewire trainer agent (Tier 1): replays pre-generated rollouts, pays a provider node per
// grade over x402, verifies the signed result, and settles at the end.
//
// Usage: node --env-file=.env packages/trainer/index.mjs [--node http://127.0.0.1:4401] [--jobs 5]
// Env: AGENT_PRIVATE_KEY, AP4M_API_URL, TEAM_NAME, CHANNEL_ID (reuse), CHANNEL_CAP (if opening).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { buyResource, loadX402Context } from '../ap4m/ap4m-x402.mjs';
import { JOB_KIND, parseJob, resultHash, resultSigningMessage, SANDBOX_IMAGE, specHash } from '../shared/index.mjs';
import { ROLLOUTS } from '../../tasks/rollouts.mjs';

const sdk = createRequire(import.meta.url)('../ap4m/ap4m-hackathon-sdk.cjs');

const { values: args } = parseArgs({ options: {
  node: { type: 'string', default: 'http://127.0.0.1:4401' },
  jobs: { type: 'string', default: '4' },
  'max-price': { type: 'string', default: '0.01' },
  'no-settle': { type: 'boolean', default: false },
} });
const AP4M_API_URL = (process.env.AP4M_API_URL || 'https://hackathon.ap4m.build').replace(/\/$/, '');
const TEAM_NAME = process.env.TEAM_NAME || 'FranksDAO';
const STATE_ROOT = process.env.TRAINER_STATE_DIR || './.state/trainer';
const INFLIGHT = `${STATE_ROOT}/inflight.json`;

function readInflight() {
  try { return JSON.parse(readFileSync(INFLIGHT, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

// The AP4M service occasionally answers with an HTML error page; retry those calls.
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (error) {
      if (i >= attempts) throw error;
      console.log(`  [retry] ${label} failed (${String(error.message).slice(0, 80)}); attempt ${i + 1}/${attempts} in ${i * 3}s`);
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${url} returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`${url} failed (${res.status}): ${data.error ?? text.slice(0, 200)}`);
  return data;
}

function makeJob(rollout) {
  return parseJob({
    job_id: `j_${randomBytes(8).toString('hex')}`,
    kind: JOB_KIND, image: SANDBOX_IMAGE, timeout_s: 20,
    files: rollout.files, reward_rule: 'fraction_passed', max_price: args['max-price'],
  });
}

async function main() {
  if (!process.env.AGENT_PRIVATE_KEY) throw new Error('set AGENT_PRIVATE_KEY');
  const nodeUrl = args.node.replace(/\/$/, '');
  mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  const context = await loadX402Context(AP4M_API_URL);
  const explorer = config.network.explorerUrl;

  console.log(`[trainer] agent ${wallet.address}; node ${nodeUrl}`);
  const info = await (await fetch(`${nodeUrl}/info`)).json();
  console.log(`[trainer] provider ${info.provider} price ${info.price_rlusd} RLUSD payout ${info.payout}`);
  if (BigInt(info.price_wei) > ethers.parseUnits(args['max-price'], 18)) throw new Error(`provider price ${info.price_rlusd} exceeds max ${args['max-price']}`);

  const { token } = await withRetry('signIn', () => sdk.signIn(AP4M_API_URL, TEAM_NAME, wallet));
  let channelId = process.env.CHANNEL_ID || '';
  if (!channelId) {
    const cap = process.env.CHANNEL_CAP || '1';
    console.log(`[trainer] opening a Channel with a ${cap} RLUSD cap`);
    channelId = (await sdk.requestChannel(AP4M_API_URL, token, wallet, { capRlusd: cap })).channel_id;
  }
  const state = await sdk.getChannelState(provider, config.contracts.paymentLedger, channelId);
  console.log(`[trainer] channel ${channelId} cap ${ethers.formatUnits(state.cap, 18)} redeemed ${ethers.formatUnits(state.redeemed, 18)} RLUSD`);

  // Pays for one grade and verifies it. `item` is written to disk before the purchase so a
  // crash mid-payment resumes the same purchase on the next run instead of abandoning it.
  async function purchaseGrade(item) {
    const { job, offer, rollout } = item;
    const t0 = Date.now();
    const operation = `grade-${job.job_id.slice(2)}`;
    writeFileSync(INFLIGHT, JSON.stringify(item));
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
    if (ethers.verifyMessage(resultSigningMessage(job.job_id, result_hash), sig).toLowerCase() !== info.provider.toLowerCase() || signer.toLowerCase() !== info.provider.toLowerCase()) {
      throw new Error(`${job.job_id}: result not signed by provider`);
    }
    console.log(`[paid] ${rollout.padEnd(20)} reward ${String(result.reward).padEnd(8)} ${result.status.padEnd(7)} ${Date.now() - t0}ms  ${explorer}/tx/${purchase.transactionHash}`);
    await withRetry('record-redemption', () => postJson(`${AP4M_API_URL}/public/participant/record-redemption`, { tx_hash: purchase.transactionHash }, { Authorization: `Bearer ${token}` }));
    unlinkSync(INFLIGHT);
    return { rollout, reward: result.reward, tx: purchase.transactionHash };
  }

  const rewards = [];
  const inflight = readInflight();
  if (inflight) {
    console.log(`[trainer] resuming unfinished purchase ${inflight.job.job_id} (${inflight.rollout})`);
    rewards.push(await purchaseGrade(inflight));
  }
  const count = Math.min(Number(args.jobs), ROLLOUTS.length);
  for (let i = 0; i < count; i++) {
    const rollout = ROLLOUTS[i];
    const job = makeJob(rollout);
    const offer = await postJson(`${nodeUrl}/jobs`, job);
    rewards.push(await purchaseGrade({ job, offer, rollout: rollout.id, channelId }));
  }

  const mean = rewards.reduce((a, r) => a + r.reward, 0) / rewards.length;
  console.log(`[trainer] ${rewards.length} grades, mean reward ${mean.toFixed(3)}, spent ${ethers.formatUnits(BigInt(info.price_wei) * BigInt(rewards.length), 18)} RLUSD`);

  if (!args['no-settle']) {
    const settled = await withRetry('settle', () => sdk.settle(AP4M_API_URL, token, channelId));
    console.log(`[settled] ${settled.amount_rlusd} RLUSD to ${settled.recipient}  payout tx ${explorer}/tx/${settled.payout_tx}`);
    if (settled.receipt_url) console.log(`[receipt] ${AP4M_API_URL}${settled.receipt_url}`);
  }
}

main().catch((error) => { console.error(error.message ?? error); process.exit(1); });
