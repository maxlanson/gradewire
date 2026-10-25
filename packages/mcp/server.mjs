// Gradewire as a tool for any AI agent, over MCP (stdio). Four tools:
//   gradewire_nodes   which nodes are selling compute, with price, reliability and earned trust
//   gradewire_run     start paying nodes to run deterministic Python programs (returns a run id)
//   gradewire_wait    follow that run; results come back only when
//                     verified (3 independent re-runs, verdict on-chain) or not sampled this time;
//                     a node whose result does not reproduce is slashed and its work rerouted
//   gradewire_status  what the network has paid, verified, caught and refunded so far
//
// Runs on the laptop that holds the agent wallet: node --env-file=.env packages/mcp/server.mjs
// The same engine the ask CLI and the RL trainer use (packages/trainer/engine.mjs) does the
// paying, gating and rerouting; this file only exposes it. stdout is the MCP channel, so every
// log line goes to stderr.

import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ethers } from 'ethers';
import { z } from 'zod';

import { parseJob, SANDBOX_IMAGE, SCRIPT_KIND } from '../shared/index.mjs';
import { describeTrust } from '../shared/trust.mjs';
import { getJson, runPaidJobs } from '../trainer/engine.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
console.log = (...a) => console.error(...a); // nothing but protocol frames may touch stdout

const COORD = (process.env.COORDINATOR_URL || 'http://127.0.0.1:4500').replace(/\/$/, '');
const EXPLORER = 'https://explorer.testnet.xrplevm.org';
const fmt = (wei) => ethers.formatUnits(BigInt(wei || 0), 18);
const log = (tag, msg) => console.error(`${new Date().toISOString().slice(11, 19)} ${String(tag).padEnd(10)} ${msg}`);

const server = new McpServer({ name: 'gradewire', version: '0.1.0' });

server.registerTool('gradewire_nodes', {
  title: 'List Gradewire nodes',
  description: 'Nodes currently selling verified compute: label, price per job in RLUSD, reliability score, earned trust (how many unverified jobs the agent will hold with them and how often their results are re-run), status and whether they are online. Use min_score to see only the nodes the agent would pay.',
  inputSchema: { min_score: z.number().min(0).max(1).optional().describe('only nodes scoring at least this (the agent default is 0.8)') },
}, async ({ min_score }) => {
  const { providers } = await getJson(`${COORD}/providers${min_score != null ? `?min_score=${min_score}` : ''}`);
  const rows = providers.map((p) => ({ label: p.label, address: p.address, status: p.status, online: p.online, price_rlusd: p.price_rlusd, score: p.score, trust: describeTrust(p.trust), jobs: p.jobs_ok, verified: p.verified_ok, failed_checks: p.verified_fail, bond_rlusd: p.bond_rlusd }));
  const text = rows.map((r) => `${r.label}: ${r.status}${r.online === false ? ' (offline)' : ''}, ${r.price_rlusd} RLUSD/job, score ${r.score}, ${r.trust}, ${r.jobs} jobs (${r.verified} verified${r.failed_checks ? `, ${r.failed_checks} failed` : ''})`).join('\n') || 'no nodes registered';
  return { content: [{ type: 'text', text }], structuredContent: { nodes: rows } };
});

server.registerTool('gradewire_status', {
  title: 'Gradewire network status',
  description: 'Totals for the live network: jobs paid, RLUSD paid to nodes, jobs verified on-chain, cheaters caught, RLUSD refunded to agents from slashed bonds, and the paying agent\'s spending caps per node.',
  inputSchema: {},
}, async () => {
  const s = await getJson(`${COORD}/state`);
  const refunded = s.incidents.filter((i) => i.kind === 'slash').reduce((a, i) => a + Number((i.detail.match(/([\d.]+) RLUSD refunded/) || [0, 0])[1]), 0);
  const summary = {
    jobs_paid: s.jobs.length, rlusd_paid: s.payments.reduce((a, p) => a + Number(fmt(p.amount_wei)), 0).toFixed(2),
    verified_on_chain: s.jobs.filter((j) => j.verdict === 'pass' || j.verdict === 'fail').length, sampled: s.jobs.filter((j) => j.sampled).length,
    cheaters_caught: s.jobs.filter((j) => j.verdict === 'fail').length, rlusd_refunded: refunded.toFixed(3),
    nodes_active: s.providers.filter((p) => p.status === 'active' && p.online !== false).length, nodes_total: s.providers.length,
    budgets: (s.budgets || []).map((b) => ({ agent: b.agent, max_price_rlusd: fmt(b.max_price_wei), min_score: b.min_score, channels: b.channels.map((c) => ({ node: c.label, cap_rlusd: fmt(c.cap_wei), spent_rlusd: fmt(c.spent_wei), status: c.status })) })),
    dashboard: `${COORD}/`, explorer: EXPLORER,
  };
  const text = `${summary.jobs_paid} jobs paid (${summary.rlusd_paid} RLUSD), ${summary.verified_on_chain} of ${summary.sampled} sampled jobs verified on-chain, ${summary.cheaters_caught} cheater(s) caught, ${summary.rlusd_refunded} RLUSD refunded; ${summary.nodes_active} of ${summary.nodes_total} nodes active`;
  return { content: [{ type: 'text', text }], structuredContent: summary };
});

const Program = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/i).describe('your label for this program, e.g. part-1'),
  code: z.string().min(1).max(8192).describe('a self-contained, deterministic Python 3 program: no network, no randomness, no clock, prints its result to stdout, finishes within 20 s on one CPU core'),
});

// Runs are asynchronous: gradewire_run returns a run id at once (an MCP host may time out a
// tool call after a minute, and a run takes one to three), and gradewire_wait reports progress
// and, when done, the results. Runs live in memory for the life of this server process.
const runs = new Map();
const describeEvent = (e) => {
  switch (e.type) {
    case 'dispatch': return `${e.provider}: 402 received for ${e.id}, paying ${fmt(e.price_wei)} RLUSD${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`;
    case 'paid': return `${e.provider}: paid ${fmt(e.price_wei)} RLUSD for ${e.id}, output received (${e.result.status}, exit ${e.result.exit_code}) ${e.explorer}/tx/${e.tx}`;
    case 'verdict': return e.verdict === 'pass' ? `${e.provider}: ${e.id} verified on-chain by 3 re-runs ${e.explorer}/tx/${e.verdict_tx}` : e.verdict === 'not_sampled' ? `${e.provider}: ${e.id} not sampled this time, accepted on earned trust` : e.verdict === 'fail' ? `${e.provider}: ${e.id} FAILED verification (result did not reproduce), discarded and rerouted ${e.explorer}/tx/${e.verdict_tx}` : `${e.provider}: ${e.id} verdict ${e.verdict}`;
    case 'fraud': return `${e.provider} caught cheating: bond slashed, this agent refunded${e.slash_tx ? ` ${e.explorer}/tx/${e.slash_tx}` : ''}`;
    case 'reroute': return `${e.id} leaves ${e.provider} (${e.reason})`;
    case 'return': return `${e.provider} is back online (score ${e.score}, ${describeTrust(e.trust)}); given work again`;
    case 'trust': return `${e.provider} trust ${e.max_inflight > e.previous_inflight ? 'up' : 'down'}: ${describeTrust(e)}`;
    case 'giveup': return `gave up on ${e.id} after ${e.attempts} attempts`;
    default: return null;
  }
};

server.registerTool('gradewire_run', {
  title: 'Run programs on paid, verified nodes',
  description: 'Starts paying untrusted nodes in RLUSD over Mastercard AP4M x402 (one HTTP 402 payment per program) to run your Python programs in a locked-down deterministic sandbox. Returns immediately with a run_id; call gradewire_wait with it to follow progress and get the results. Each result ends up either "pass" (3 independent verifiers re-ran the program and the hash matched, verdict posted on XRPL EVM) or "not_sampled" (accepted on the node\'s earned trust). A result that does not reproduce slashes the node\'s bond, refunds this agent and is rerouted to another node automatically; a node that goes offline mid-job is rerouted around. Write programs that print everything you need; stdout is capped at 16 KiB; aim for about 10 s of CPU, under 30 s. Typical cost 0.01 RLUSD per program, 1-3 minutes wall time for a batch.',
  inputSchema: {
    programs: z.array(Program).min(1).max(8),
    max_price_rlusd: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('most to pay per program (default 0.01)'),
    min_score: z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/).optional().describe('lowest node reliability score to accept (default 0.8)'),
  },
}, async ({ programs, max_price_rlusd = '0.01', min_score = '0.8' }) => {
  const scriptJob = (code) => ({ job_id: `j_${randomBytes(8).toString('hex')}`, kind: SCRIPT_KIND, image: SANDBOX_IMAGE, timeout_s: 45, files: [{ path: 'main.py', content: code }], reward_rule: 'fraction_passed', max_price: max_price_rlusd });
  for (const p of programs) parseJob(scriptJob(p.code)); // rejects anything a node would refuse before any payment
  if ([...runs.values()].some((r) => r.status === 'running')) return { content: [{ type: 'text', text: 'a run is already in progress; call gradewire_wait on it first (the payment Channels are shared)' }], isError: true };
  const id = `run_${randomBytes(4).toString('hex')}`;
  const run = { id, status: 'running', started: Date.now(), events: [], lines: [], outcome: null, error: null, programs: programs.map((p) => p.id) };
  runs.set(id, run);
  const items = programs.map((p) => ({ id: p.id, files: [{ path: 'main.py', content: p.code }] }));
  runPaidJobs({
    items, buildJob: (item) => parseJob(scriptJob(item.files[0].content)), maxPrice: max_price_rlusd, minScore: min_score,
    settle: false, log, agentTag: '[mcp]',
    onEvent: (e) => { const text = describeEvent(e); if (text) run.lines.push(`${new Date().toISOString().slice(11, 19)} ${text}`); if (e.type !== 'done') run.events.push(e); },
  }).then((outcome) => { run.outcome = outcome; run.status = 'done'; }).catch((e) => { run.error = String(e?.message || e); run.status = 'failed'; });
  return { content: [{ type: 'text', text: `run ${id} started: ${programs.length} program(s) sent to the network. Call gradewire_wait with run_id "${id}" (it returns within ~45 s with progress, and the results once done).` }], structuredContent: { run_id: id, status: 'running', programs: run.programs, dashboard: `${COORD}/` } };
});

function summarize(run) {
  const outcome = run.outcome;
  const results = outcome.results.map((r) => ({
    id: r.id, node: r.provider, verdict: r.verdict, usable: (r.verdict === 'pass' || r.verdict === 'not_sampled') && r.result.status === 'ok',
    status: r.result.status, exit_code: r.result.exit_code, output: r.result.output, truncated: r.result.truncated,
    price_rlusd: fmt(r.price_wei), payment_tx: `${EXPLORER}/tx/${r.tx}`, verdict_tx: r.verdict_tx ? `${EXPLORER}/tx/${r.verdict_tx}` : null,
  }));
  const paid = outcome.results.reduce((a, r) => a + Number(fmt(r.price_wei)), 0);
  const caught = outcome.events.filter((e) => e.kind === 'fraud');
  const summary = {
    run_id: run.id, status: 'done', results, unassigned: outcome.unassigned.map((u) => u.id), paid_rlusd: paid.toFixed(2), nodes_used: [...new Set(outcome.results.map((r) => r.provider))],
    verified_on_chain: results.filter((r) => r.verdict === 'pass').length, nodes_caught_cheating: caught.map((c) => c.provider),
    agent_balance_change_rlusd: Number(fmt(outcome.endBalance - outcome.startBalance)).toFixed(3), explorer: EXPLORER, dashboard: `${COORD}/`,
  };
  const lines = results.map((r) => `${r.id} on ${r.node}: ${r.verdict}${r.usable ? '' : ' (NOT USABLE)'}, exit ${r.exit_code}\n${(r.output || '').trimEnd().split('\n').map((l) => '  > ' + l).join('\n')}`);
  if (summary.unassigned.length) lines.push(`not completed: ${summary.unassigned.join(', ')}`);
  lines.push(`paid ${summary.paid_rlusd} RLUSD over AP4M x402 to ${summary.nodes_used.join(', ')}; ${summary.verified_on_chain} verified on-chain${caught.length ? `; caught cheating: ${summary.nodes_caught_cheating.join(', ')} (bond slashed, this agent refunded)` : ''}`);
  return { text: lines.join('\n\n'), summary };
}

server.registerTool('gradewire_wait', {
  title: 'Wait for a Gradewire run',
  description: 'Follows a run started by gradewire_run. Blocks up to wait_s (default 45 s, max 50) and returns the progress lines that are new since your last call (payments, verdicts, cheaters caught, reroutes, nodes returning). When the run is done it also returns the results; keep calling until status is "done" or "failed".',
  inputSchema: { run_id: z.string(), wait_s: z.number().int().min(1).max(50).optional() },
}, async ({ run_id, wait_s = 45 }) => {
  const run = runs.get(run_id);
  if (!run) return { content: [{ type: 'text', text: `unknown run ${run_id}` }], isError: true };
  const since = run.lines.length;
  const deadline = Date.now() + wait_s * 1000;
  while (run.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  const fresh = run.lines.slice(since);
  const elapsed = Math.round((Date.now() - run.started) / 1000);
  if (run.status === 'done') {
    const { text, summary } = summarize(run);
    return { content: [{ type: 'text', text: `${fresh.join('\n')}\n\nrun ${run.id} done after ${elapsed} s.\n\n${text}` }], structuredContent: { ...summary, progress: fresh } };
  }
  if (run.status === 'failed') return { content: [{ type: 'text', text: `${fresh.join('\n')}\n\nrun ${run.id} failed after ${elapsed} s: ${run.error}` }], structuredContent: { run_id: run.id, status: 'failed', error: run.error, progress: fresh }, isError: true };
  return { content: [{ type: 'text', text: `${fresh.join('\n') || '(no new events yet)'}\n\nrun ${run.id} still running after ${elapsed} s; call gradewire_wait again.` }], structuredContent: { run_id: run.id, status: 'running', elapsed_s: elapsed, progress: fresh } };
});

await server.connect(new StdioServerTransport());
console.error('[mcp] gradewire server ready (stdio)');
