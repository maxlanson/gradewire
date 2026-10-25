// Gradewire "ask": an AI on your laptop answers a question by farming the computation out to
// paid, verified nodes. The model writes 1..N independent Python programs; each one becomes a
// python-script job that is paid for over Mastercard AP4M x402 (RLUSD on XRPL EVM Testnet),
// run in a locked-down sandbox on a different node, sampled by the coordinator and re-run by
// three verifiers. Only results that verified (or were not sampled) feed the final answer; a
// node whose result failed verification is dropped, slashed, and its part rerouted.
//
// Usage: scripts/ask.sh "How many primes are there below 10 million?" [--parts 3] [--max-price 0.01]
//        [--min-score 0.8] [--no-settle] [--dry-run] [--node URL] [--coordinator URL]
// Model: ANTHROPIC_API_KEY set -> the Anthropic SDK (model ASK_MODEL, default claude-sonnet-5-5);
//        otherwise the local Claude Code CLI (`claude -p --output-format json`).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { ethers } from 'ethers';

import { parseJob, SANDBOX_IMAGE, SCRIPT_KIND, specHash } from '../shared/index.mjs';
import { runPaidJobs } from '../trainer/engine.mjs';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  parts: { type: 'string', default: '3' },
  'max-price': { type: 'string', default: '0.01' },
  'min-score': { type: 'string', default: '0.8' },
  'no-settle': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  node: { type: 'string' },
  coordinator: { type: 'string', default: process.env.COORDINATOR_URL || 'http://127.0.0.1:4500' },
} });

const QUESTION = positionals.join(' ').trim();
const PARTS = Number(args.parts);
const MAX_PROGRAM_BYTES = 8 * 1024;
const MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'; // resolved on PATH unless CLAUDE_BIN gives a path
const USE_SDK = !!process.env.ANTHROPIC_API_KEY;
const MODEL_TIMEOUT_MS = 240_000;
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (msg = '') => console.log(msg);
const fmt = (wei) => ethers.formatUnits(BigInt(wei), 18);

// ── model access ─────────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['programs', 'combine'],
  properties: {
    programs: { type: 'array', minItems: 1, maxItems: PARTS, items: { type: 'object', additionalProperties: false, required: ['label', 'code'], properties: { label: { type: 'string' }, code: { type: 'string' } } } },
    combine: { type: 'string' },
  },
};

const PLAN_SYSTEM = `You split a question into independent Python 3 programs that untrusted remote computers will run for pay, in a locked-down sandbox, and that other machines will re-run to verify bit-for-bit.
Rules for every program:
- Python 3.12, standard library only. No pip packages, no network, no files, no subprocesses, no threads, no input().
- Fully deterministic: no randomness, no clock, no environment lookups, no hash-order dependence (sort before printing). Two machines must print exactly the same bytes.
- Must finish in under 15 seconds on one CPU core with 512 MB of RAM. Prefer simple, fast algorithms; keep memory modest (a bytearray sieve is fine, giant lists of Python ints are not).
- Print the result to stdout as short labelled text, under 2 KB.
Write between 1 and ${PARTS} programs. The parts run in parallel on different machines, so prefer exactly ${PARTS} parts whenever the work can be partitioned (numeric ranges, cases, sub-questions), and make each part useful alone; write a single program only when splitting makes no sense. Each program must be independent of the others (no shared state, no reading another part's output).
If the question is not computational, write one program that computes whatever evidence best supports a precise answer.
Return strict JSON only, no prose and no code fences: {"programs":[{"label":"short label","code":"python source"}],"combine":"one or two sentences on how to combine the outputs into the final answer"}`;

const ANSWER_SYSTEM = `You answer the user's question using outputs that remote nodes computed for pay and that were verified by independent re-runs. Treat the outputs as ground truth. If a part is missing or timed out, say so and answer with what is available. Be concise: lead with the answer, then at most a few lines of explanation.`;

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return a JSON object');
  return JSON.parse(t.slice(start, end + 1));
}

async function callSdk({ system, prompt, schema }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment; never log it
  const response = await client.messages.create({
    model: MODEL, max_tokens: 16000, system, messages: [{ role: 'user', content: prompt }],
    ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}),
  });
  if (response.stop_reason === 'refusal') throw new Error(`model refused (${response.stop_details?.category ?? 'no category'})`);
  if (response.stop_reason === 'max_tokens') throw new Error('model output was cut off (max_tokens)');
  return { text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), model: response.model };
}

function callCli({ system, prompt }) {
  if (CLAUDE_BIN.includes('/') && !existsSync(CLAUDE_BIN)) throw new Error(`claude CLI not found at ${CLAUDE_BIN} (set ANTHROPIC_API_KEY or CLAUDE_BIN)`);
  const env = { ...process.env };
  delete env.CLAUDECODE; // the child is a fresh CLI run, not a nested session
  const cliArgs = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--append-system-prompt', system];
  if (process.env.ASK_MODEL) cliArgs.push('--model', process.env.ASK_MODEL);
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, cliArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude CLI timed out after ${MODEL_TIMEOUT_MS / 1000}s`)); }, MODEL_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data;
      try { data = JSON.parse(out); } catch { return reject(new Error(`claude CLI exited ${code} without JSON output: ${(err || out).slice(0, 300)}`)); }
      if (data.is_error || typeof data.result !== 'string') return reject(new Error(`claude CLI error: ${String(data.result ?? data.error ?? err).slice(0, 300)}`));
      resolve({ text: data.result, model: Object.keys(data.modelUsage ?? {})[0] ?? null, cost_usd: data.total_cost_usd });
    });
    child.stdin.end(prompt);
  });
}

const callModel = (opts) => (USE_SDK ? callSdk(opts) : callCli(opts));

// ── plan ─────────────────────────────────────────────────────────────────────

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.programs)) throw new Error('plan.programs must be an array');
  if (plan.programs.length < 1 || plan.programs.length > PARTS) throw new Error(`plan must have 1..${PARTS} programs, got ${plan.programs.length}`);
  if (typeof plan.combine !== 'string') throw new Error('plan.combine must be a string');
  const programs = plan.programs.map((p, i) => {
    if (!p || typeof p.label !== 'string' || typeof p.code !== 'string') throw new Error(`program ${i + 1} must be {label, code}`);
    if (!p.code.includes('print')) throw new Error(`program ${i + 1} (${p.label}) never prints`);
    if (Buffer.byteLength(p.code) > MAX_PROGRAM_BYTES) throw new Error(`program ${i + 1} (${p.label}) exceeds ${MAX_PROGRAM_BYTES} bytes`);
    const label = p.label.replace(/\s+/g, ' ').trim().slice(0, 60) || `part ${i + 1}`;
    return { id: `part-${i + 1}`, label, code: p.code.endsWith('\n') ? p.code : `${p.code}\n` };
  });
  return { programs, combine: plan.combine.trim() };
}

async function makePlan(question) {
  const prompt = `Question: ${question}\n\nWrite the plan now as strict JSON.`;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, model, cost_usd } = await callModel({ system: PLAN_SYSTEM, prompt: attempt === 1 ? prompt : `${prompt}\n\nYour previous answer was rejected: ${lastError}. Return only the JSON object.`, schema: PLAN_SCHEMA });
    try {
      const plan = validatePlan(extractJson(text));
      // Every program must also be a valid job: this catches oversize specs before anything is paid.
      for (const p of plan.programs) parseJob(scriptJob(p.code));
      return { ...plan, model, cost_usd };
    } catch (e) { lastError = e.message; say(`${stamp()} [plan]     rejected (${e.message}); asking again`); }
  }
  throw new Error(`could not get a valid plan: ${lastError}`);
}

const scriptJob = (code) => ({ job_id: `j_${randomBytes(8).toString('hex')}`, kind: SCRIPT_KIND, image: SANDBOX_IMAGE, timeout_s: 20, files: [{ path: 'main.py', content: code }], reward_rule: 'fraction_passed', max_price: args['max-price'] });

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!QUESTION) throw new Error('usage: scripts/ask.sh "<question>" [--parts 3] [--max-price 0.01] [--min-score 0.8] [--no-settle] [--dry-run] [--node URL]');
  if (!Number.isInteger(PARTS) || PARTS < 1 || PARTS > 8) throw new Error('--parts must be 1..8');
  say(`question: ${QUESTION}`);
  say(`model: ${USE_SDK ? `Anthropic SDK (${MODEL})` : `claude CLI${process.env.ASK_MODEL ? ` (${process.env.ASK_MODEL})` : ''}`}`);
  say(`budget: up to ${args['max-price']} RLUSD per part, up to ${PARTS} parts${args['dry-run'] ? '  (dry run: nothing is paid)' : ''}`);
  say();

  // (a) plan
  say(`${stamp()} [plan]     asking the model for up to ${PARTS} independent programs…`);
  const plan = await makePlan(QUESTION);
  say(`${stamp()} [plan]     ${plan.programs.length} program${plan.programs.length === 1 ? '' : 's'}${plan.model ? ` from ${plan.model}` : ''}${plan.cost_usd ? ` ($${plan.cost_usd.toFixed(3)} of model time)` : ''}`);
  say(`${stamp()} [plan]     combine: ${plan.combine}`);
  const labelOf = Object.fromEntries(plan.programs.map((p) => [p.id, p.label]));

  // (b) one python-script job per program
  const items = plan.programs.map((p) => ({ id: p.id, files: [{ path: 'main.py', content: p.code }] }));
  const buildJob = (item) => parseJob(scriptJob(item.files[0].content));
  for (const p of plan.programs) {
    const job = buildJob({ files: [{ path: 'main.py', content: p.code }] });
    const lines = p.code.trimEnd().split('\n');
    say();
    say(`── ${p.id}: ${p.label}  (${lines.length} lines, ${Buffer.byteLength(p.code)} bytes, spec ${specHash(job).slice(0, 16)}…)`);
    if (args['dry-run']) for (const l of lines) say(`   │ ${l}`);
    else for (const l of lines.slice(0, 4)) say(`   │ ${l}`);
    if (!args['dry-run'] && lines.length > 4) say(`   │ … ${lines.length - 4} more lines`);
  }
  say();
  if (args['dry-run']) {
    say('dry run: every program parsed as a python-script job (image pinned by digest, 20 s timeout, no network). Nothing was paid.');
    say(`a live run would pay up to ${plan.programs.length} × ${args['max-price']} RLUSD over AP4M x402 and verify the results on XRPL EVM.`);
    return;
  }

  // (c) pay, run, verify: the engine does the x402 purchases, gating, ban and reroute
  const paidEvents = [];
  let verifiedOnChain = 0;
  let outcome;
  const engineLog = (tag, msg) => {
    // Provider-tagged lines are covered by the events below; keep the agent's own lines.
    if (!['[agent]', '[retry]', '[settled]', '[receipt]', '[settle]', '[closed]', '[close]'].includes(tag)) return;
    say(`${stamp()} ${tag.padEnd(10)} ${msg}`);
  };
  outcome = await runPaidJobs({
    items, buildJob, maxPrice: args['max-price'], minScore: args['min-score'], node: args.node, coordinator: args.coordinator,
    settle: !args['no-settle'], log: engineLog, agentTag: '[agent]',
    onEvent(event) {
      const name = (id) => `${id} "${labelOf[id] ?? id}"`;
      switch (event.type) {
        case 'providers':
          say(`${stamp()} [nodes]    ${event.providers.map((p) => `${p.label} (score ${p.score}, ${fmt(p.price_wei)} RLUSD/job)`).join(', ')}`);
          break;
        case 'dispatch':
          say(`${stamp()} [${event.provider}] running ${name(event.id)}${event.attempt > 1 ? ` (attempt ${event.attempt})` : ''}: 402 received, paying ${fmt(event.price_wei)} RLUSD…`);
          break;
        case 'paid': {
          paidEvents.push(event);
          const status = event.result.status === 'ok' ? `exit ${event.result.exit_code}` : event.result.status;
          say(`${stamp()} [${event.provider}] paid ${fmt(event.price_wei)} RLUSD for ${name(event.id)} (${status}, ${event.ms} ms)  VoucherRedeemed ${event.explorer}/tx/${event.tx}`);
          const preview = String(event.result.output ?? '').trim().split('\n').slice(0, 3);
          for (const l of preview) say(`${' '.repeat(9)}${' '.repeat(event.provider.length + 3)}> ${l.slice(0, 160)}`);
          say(`${stamp()} [${event.provider}] waiting for the coordinator's verdict on ${event.id}…`);
          break;
        }
        case 'verdict':
          if (event.verdict === 'pass') { verifiedOnChain++; say(`${stamp()} [${event.provider}] ✓ ${event.id} verified: 3 verifiers re-ran it, hashes match, verdict on-chain  ${event.explorer}/tx/${event.verdict_tx}`); }
          else if (event.verdict === 'not_sampled') say(`${stamp()} [${event.provider}] · ${event.id} not sampled this time; result accepted`);
          else if (event.verdict === 'fail') say(`${stamp()} [${event.provider}] ✗ ${event.id} FAILED verification: the output did not reproduce. Result discarded, no further payments to ${event.provider}, rerouting ${event.id}.  ${event.explorer}/tx/${event.verdict_tx}`);
          else say(`${stamp()} [${event.provider}] ? ${event.id} verdict ${event.verdict}: not using this result until it verifies`);
          break;
        case 'fraud':
          say(`${stamp()} [slash]    ${event.provider}'s bond is being slashed; the refund lands in this agent's wallet${event.slash_tx ? `  ${event.explorer}/tx/${event.slash_tx}` : ''}`);
          break;
        case 'reroute':
          say(`${stamp()} [reroute]  ${event.id} leaves ${event.provider} (${event.reason})`);
          break;
        default:
      }
    },
  });

  // (d) answer from verified or not-sampled outputs only
  const accepted = outcome.results.filter((r) => (r.verdict === 'pass' || r.verdict === 'not_sampled') && r.result.status === 'ok');
  const byId = new Map(accepted.map((r) => [r.id, r]));
  const missing = plan.programs.filter((p) => !byId.has(p.id));
  say();
  say(`${stamp()} [answer]   ${accepted.length}/${plan.programs.length} parts have a verified or not-sampled result${missing.length ? ` (missing: ${missing.map((m) => m.id).join(', ')})` : ''}; asking the model for the final answer…`);
  const outputs = plan.programs.map((p) => {
    const r = byId.get(p.id);
    const header = `## ${p.id}: ${p.label}` + (r ? ` (node ${r.provider}, verdict ${r.verdict})` : ' (NO RESULT: failed, timed out or unassigned)');
    return `${header}\n${r ? (r.result.output || '(empty output)') + (r.result.truncated ? '\n[output truncated]' : '') : ''}`;
  }).join('\n\n');
  const prompt = `Question: ${QUESTION}\n\nPlan (how to combine the parts): ${plan.combine}\n\nPrograms and their verified outputs:\n\n${plan.programs.map((p) => `### ${p.id}: ${p.label}\n\`\`\`python\n${p.code}\`\`\``).join('\n\n')}\n\n${outputs}\n\nAnswer the question.`;
  const answer = await callModel({ system: ANSWER_SYSTEM, prompt });
  say();
  say('┌─ answer ─────────────────────────────────────────────────────────');
  for (const l of answer.text.trim().split('\n')) say(`│ ${l}`);
  say('└──────────────────────────────────────────────────────────────────');

  // (e) footer
  const totalPaid = paidEvents.reduce((a, e) => a + BigInt(e.price_wei), 0n);
  const nodes = new Set(paidEvents.map((e) => e.provider));
  const refund = outcome.endBalance > outcome.startBalance ? outcome.endBalance - outcome.startBalance : 0n;
  say();
  say(`paid ${ethers.formatUnits(totalPaid, 18)} RLUSD over AP4M x402 · ${nodes.size} node${nodes.size === 1 ? '' : 's'} used · ${verifiedOnChain} job${verifiedOnChain === 1 ? '' : 's'} verified on-chain · ${outcome.banned.length} node${outcome.banned.length === 1 ? '' : 's'} caught cheating · refunds received ${ethers.formatUnits(refund, 18)} RLUSD`);
}

main().catch((error) => { console.error(error.shortMessage ?? error.message ?? error); process.exit(1); });
