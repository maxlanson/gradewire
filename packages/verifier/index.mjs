// Gradewire verifier operator: watches NewTaskCreated, re-runs the sampled job in the same
// sandbox, and responds on-chain with an EIP-712-signed (taskId, matched, hash).
//
// Usage: node --env-file=.env packages/verifier/index.mjs --operator 1
// Env: OPERATOR{n}_PRIVATE_KEY, COORDINATOR_URL (job specs), QUICKNODE_RPC_URL/AP4M_RPC_URL.

import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { contracts, hex32, loadDeployment, responseTypedData, rpcUrl } from '../shared/chain.mjs';
import { parseJob, resultHash } from '../shared/index.mjs';
import { runJob } from '../node/sandbox.mjs';

const { values: args } = parseArgs({ options: { operator: { type: 'string', default: '1' }, poll: { type: 'string', default: '4000' } } });
const COORDINATOR_URL = (process.env.COORDINATOR_URL || 'http://127.0.0.1:4500').replace(/\/$/, '');
const key = process.env[`OPERATOR${args.operator}_PRIVATE_KEY`];
if (!key) { console.error(`set OPERATOR${args.operator}_PRIVATE_KEY`); process.exit(1); }

const deployment = loadDeployment();
const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
const wallet = new ethers.Wallet(key, provider);
const { serviceManager } = contracts(provider, deployment);
const sm = serviceManager.connect(wallet);
const tag = `[verifier-${args.operator}]`;

async function respond(taskId, jobId, providerHash) {
  const task = await sm.tasks(taskId);
  if (task.finalized) return;
  if (await sm.hasResponded(taskId, wallet.address)) return;
  const spec = await (await fetch(`${COORDINATOR_URL}/jobs/${encodeURIComponent(jobId)}/spec`)).json();
  if (!spec.job) { console.log(`${tag} task ${taskId}: coordinator has no spec for ${jobId}`); return; }
  const job = parseJob(spec.job);
  const t0 = Date.now();
  const result = await runJob(job);
  const mine = hex32(resultHash(result));
  const matched = mine.toLowerCase() === providerHash.toLowerCase();
  const { domain, types } = responseTypedData(deployment, (await provider.getNetwork()).chainId);
  const signature = await wallet.signTypedData(domain, types, { taskId, matched, operatorHash: mine });
  // Quorum is 2 of 3: if the other two already agreed, the task is finalized and our response
  // would revert. Check once more right before sending, and treat a late revert as "already decided".
  if ((await sm.tasks(taskId)).finalized) { console.log(`${tag} task ${taskId} ${jobId} re-ran in ${Date.now() - t0}ms: ${matched ? 'MATCH' : 'MISMATCH'} (quorum already reached, not submitted)`); return; }
  // Explicit gas: if another operator's response lands first, ours becomes the finalizing one
  // and also runs the slash (three RLUSD transfers), far above the gas estimated beforehand.
  let receipt;
  try {
    receipt = await (await sm.respondToTask(taskId, matched, mine, signature, { gasLimit: 900_000 })).wait();
  } catch (error) {
    if ((await sm.tasks(taskId)).finalized) { console.log(`${tag} task ${taskId}: quorum reached while submitting; not needed`); return; }
    throw error;
  }
  console.log(`${tag} task ${taskId} ${jobId} re-ran in ${Date.now() - t0}ms: ${matched ? 'MATCH' : 'MISMATCH'} mine=${mine.slice(0, 14)} provider=${providerHash.slice(0, 14)} tx=${receipt.hash}`);
}

async function main() {
  console.log(`${tag} ${wallet.address} watching ${deployment.serviceManager} via ${rpcUrl(deployment)}`);
  if (!(await sm.isOperator(wallet.address))) throw new Error('this wallet is not an allowlisted operator');
  let from = Math.max(deployment.deployBlock, (await provider.getBlockNumber()) - 2000);
  // Tasks stay in `pending` until we have responded or the task is finalized, so a failed
  // attempt (RPC flake, gas race, Docker hiccup) is retried instead of lost.
  const pending = new Map(); // taskId -> { jobIdHash, providerHash, attempts, nextAt }
  const done = new Set();
  const topic = serviceManager.interface.getEvent('NewTaskCreated').topicHash;
  for (;;) {
    try {
      const head = await provider.getBlockNumber();
      if (head >= from) {
        const logs = await provider.getLogs({ address: deployment.serviceManager, topics: [topic], fromBlock: from, toBlock: head });
        for (const log of logs) {
          const ev = serviceManager.interface.parseLog(log);
          const taskId = Number(ev.args.taskId);
          if (!done.has(taskId) && !pending.has(taskId)) pending.set(taskId, { jobIdHash: ev.args.jobId, providerHash: ev.args.providerResultHash, attempts: 0, nextAt: 0 });
        }
        from = head + 1;
      }
    } catch (error) { console.error(`${tag} poll: ${error.shortMessage ?? error.message}`); }
    for (const [taskId, t] of pending) {
      if (t.running || Date.now() < t.nextAt) continue;
      t.running = true;
      (async () => {
        try {
          const jobId = await lookupJobId(t.jobIdHash);
          await respond(taskId, jobId, t.providerHash);
          pending.delete(taskId); done.add(taskId);
        } catch (e) {
          t.attempts++;
          if ((await sm.tasks(taskId).catch(() => ({ finalized: false }))).finalized || t.attempts >= 6) { pending.delete(taskId); done.add(taskId); console.log(`${tag} task ${taskId}: giving up (${t.attempts} attempts): ${e.shortMessage ?? e.message}`); }
          else { t.nextAt = Date.now() + 5000 * t.attempts; console.error(`${tag} task ${taskId}: ${e.shortMessage ?? e.message}; retry ${t.attempts}/6`); }
        } finally { t.running = false; }
      })();
    }
    await new Promise((r) => setTimeout(r, Number(args.poll)));
  }
}

// On-chain the job id is keccak256(job_id); the coordinator maps it back.
async function lookupJobId(jobIdHash) {
  const res = await fetch(`${COORDINATOR_URL}/jobs/by-hash/${jobIdHash}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'unknown job hash');
  return data.job_id;
}

main().catch((error) => { console.error(error.message ?? error); process.exit(1); });
