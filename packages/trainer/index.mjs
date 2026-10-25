// Gradewire trainer agent: the paying customer. Replays pre-generated RL rollouts as grading
// jobs through the shared paying client (engine.mjs): picks providers from the coordinator by
// price and reliability, opens one AP4M Channel per provider, pays per grade over x402,
// verifies every signed result, and holds the next payment to a provider until its last
// sampled job has a verdict. A failed verdict bans the provider and reroutes its work.
//
// Usage: node --env-file=.env packages/trainer/index.mjs [--jobs 8] [--node http://127.0.0.1:4401]
// Env: AGENT_PRIVATE_KEY, AP4M_API_URL, TEAM_NAME, COORDINATOR_URL, CHANNEL_ID (an open
// Channel to reuse for the first provider), CHANNEL_CAP (cap for new Channels, default 0.5).

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { JOB_KIND, parseJob, SANDBOX_IMAGE } from '../shared/index.mjs';
import { ROLLOUTS } from '../../tasks/rollouts.mjs';
import { defaultLog as log, runPaidJobs } from './engine.mjs';

const { values: args } = parseArgs({ options: {
  coordinator: { type: 'string', default: process.env.COORDINATOR_URL || 'http://127.0.0.1:4500' },
  node: { type: 'string' },
  jobs: { type: 'string', default: '8' },
  'max-price': { type: 'string', default: '0.01' },
  'min-score': { type: 'string', default: '0.8' },
  'no-settle': { type: 'boolean', default: false },
} });

const makeJob = (item) => parseJob({ job_id: `j_${randomBytes(8).toString('hex')}`, kind: JOB_KIND, image: SANDBOX_IMAGE, timeout_s: 20, files: item.files, reward_rule: 'fraction_passed', max_price: args['max-price'] });

async function main() {
  const items = ROLLOUTS.slice(0, Math.min(Number(args.jobs), ROLLOUTS.length)).map((r) => ({ id: r.id, files: r.files }));
  await runPaidJobs({
    items, buildJob: makeJob, maxPrice: args['max-price'], minScore: args['min-score'], node: args.node,
    coordinator: args.coordinator, settle: !args['no-settle'], log,
    onEvent(event) {
      if (event.type !== 'done') return;
      // ── summary ──
      const { results: done, unassigned, events, startBalance, endBalance, explorer } = event;
      const rewards = done.map((d) => d.reward);
      const mean = rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0;
      console.log('\nrollout              provider    reward   verdict      tx');
      for (const d of done) console.log(`${d.id.padEnd(20)} ${d.provider.padEnd(11)} ${String(d.reward).padEnd(8)} ${d.verdict.padEnd(12)} ${d.tx}`);
      log('[trainer]', `${done.length} accepted grades, mean reward ${mean.toFixed(3)}; ${unassigned.length} jobs left unassigned`);
      for (const e of events) log('[trainer]', `fraud: ${e.provider} banned after ${e.job_id}; slash tx ${e.slash_tx ? `${explorer}/tx/${e.slash_tx}` : 'pending'}`);
      if (endBalance !== startBalance) log('[trainer]', `agent RLUSD balance ${ethers.formatUnits(startBalance, 18)} → ${ethers.formatUnits(endBalance, 18)} (refund from slashed bond: +${ethers.formatUnits(endBalance - startBalance, 18)})`);
    },
  });
}

main().catch((error) => { console.error(error.shortMessage ?? error.message ?? error); process.exit(1); });
