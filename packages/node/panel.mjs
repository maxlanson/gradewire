// A small terminal window for one node, for the stage: its letter, how hard its machine is
// working, and every dollar figure that concerns it. Runs on the demo laptop and reads the
// node's /health (CPU, what it is running) and the coordinator (status, trust, payments,
// verdicts, bond, slash). Usage:
//   node packages/node/panel.mjs <letter> <node-url> [--coordinator http://127.0.0.1:4500] [--role honest|cheater|unreliable]
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { coordinator: { type: 'string', default: process.env.COORDINATOR_URL || 'http://127.0.0.1:4500' }, role: { type: 'string', default: '' } } });
const [LETTER = '?', NODE_URL = 'http://127.0.0.1:4401'] = positionals;
const COORD = args.coordinator.replace(/\/$/, '');
const ESC = '\x1b[';
const bold = (t) => `${ESC}1m${t}${ESC}22m`, dim = (t) => `${ESC}2m${t}${ESC}22m`;
const green = (t) => `${ESC}32m${t}${ESC}39m`, red = (t) => `${ESC}31m${t}${ESC}39m`, yellow = (t) => `${ESC}33m${t}${ESC}39m`, cyan = (t) => `${ESC}36m${t}${ESC}39m`;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BIG = {
  A: ['  ▄▀▀▄ ', '  █▄▄█ ', '  █  █ '], B: ['  █▀▀▄ ', '  █▀▀▄ ', '  █▄▄▀ '], C: ['  ▄▀▀▀ ', '  █    ', '  ▀▄▄▄ '],
  D: ['  █▀▀▄ ', '  █  █ ', '  █▄▄▀ '], E: ['  █▀▀▀ ', '  █▀▀  ', '  █▄▄▄ '], F: ['  █▀▀▀ ', '  █▀▀  ', '  █    '],
};
const getJson = async (url, ms = 3000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.json(); };
const fmt = (wei) => (Number(BigInt(wei || 0)) / 1e18);

let health = null, me = null, state = null, lastErr = '', tick = 0, cpuHist = [];
async function poll() {
  try { health = await getJson(`${NODE_URL}/health`, 2000); lastErr = ''; } catch (e) { health = null; lastErr = 'node not answering'; }
  if (health) { cpuHist.push(health.cpu_pct ?? 0); if (cpuHist.length > 24) cpuHist.shift(); }
}
async function pollCoord() {
  try {
    const s = await getJson(`${COORD}/state`, 4000);
    state = s;
    const addr = (health?.provider || me?.address || '').toLowerCase();
    me = s.providers.find((p) => p.address.toLowerCase() === addr) || s.providers.find((p) => p.endpoint === NODE_URL) || me;
  } catch { /* keep last */ }
}

function render() {
  const w = Math.max(40, Math.min(process.stdout.columns || 46, 60));
  const out = [];
  const line = (s = '') => out.push(s);
  const role = args.role || (health?.cheat ? 'cheater' : '');
  const addr = me?.address || health?.provider || '';
  const big = BIG[LETTER.toUpperCase()] || ['       ', `   ${LETTER}   `, '       '];
  const status = !health ? red('offline') : me?.status === 'suspended' ? red('suspended') : me?.status === 'active' ? (me.online === false ? yellow('offline') : green('active')) : yellow(me?.status || 'joining');
  line(`${bold(cyan(big[0]))}   ${bold(`NODE ${LETTER.toUpperCase()}`)}${role ? dim(`  ${role}`) : ''}`);
  line(`${bold(cyan(big[1]))}   ${status}${me ? dim(`  score ${Number(me.score).toFixed(2)}`) : ''}`);
  line(`${bold(cyan(big[2]))}   ${dim(addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : '')}`);
  line();
  // compute strain
  const cpu = health?.cpu_pct ?? 0;
  const barW = w - 22;
  const filled = Math.round((cpu / 100) * barW);
  const bar = (cpu > 70 ? red : cpu > 35 ? yellow : green)('▇'.repeat(filled)) + dim('░'.repeat(Math.max(0, barW - filled)));
  line(`${dim('cpu')}  ${bar} ${String(cpu).padStart(3)}%${health?.cores ? dim(` ${health.cores} cores`) : ''}`);
  const spark = cpuHist.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(v / 12.5))]).join('');
  line(`${dim('     ')}${dim(spark)}${health?.running ? `  ${green(SPIN[tick % SPIN.length])} running ${health.running} job${health.running === 1 ? '' : 's'}` : health ? dim(`  ${SPIN[tick % SPIN.length]} listening`) : ''}`);
  line();
  // dollars
  const jobs = (state?.jobs || []).filter((j) => j.provider?.toLowerCase() === addr.toLowerCase());
  const earned = (state?.payments || []).filter((p) => (p.submitter || '').toLowerCase() === addr.toLowerCase()).reduce((a, p) => a + fmt(p.amount_wei), 0);
  const slash = (state?.incidents || []).find((i) => i.kind === 'slash' && i.provider?.toLowerCase() === addr.toLowerCase());
  const refund = slash ? Number((slash.detail.match(/([\d.]+) RLUSD refunded/) || [0, 0])[1]) : 0;
  const bond = me ? Number(me.bond_rlusd) : 0;
  const price = me ? Number(me.price_rlusd) : 0.01;
  line(`${dim('price')}    ${price.toFixed(2)} RLUSD per job`);
  line(`${dim('earned')}   ${bold(green(`${earned.toFixed(2)} RLUSD`))}${jobs.length ? dim(`  ${jobs.length} job${jobs.length === 1 ? '' : 's'} paid`) : ''}`);
  line(`${dim('bond')}     ${slash ? red(`slashed (was ${(bond + refund * 2).toFixed(2)} RLUSD)`) : `${bond.toFixed(2)} RLUSD`}`);
  if (slash) line(`${dim('refund')}   ${red(`${refund.toFixed(3)} RLUSD to the agent`)}`);
  const verified = jobs.filter((j) => j.verdict === 'pass').length, failed = jobs.filter((j) => j.verdict === 'fail').length, checking = jobs.filter((j) => j.sampled && j.verdict === 'pending').length;
  line(`${dim('checks')}   ${green(`${verified} verified`)}${checking ? yellow(`  ${checking} checking`) : ''}${failed ? red(`  ${failed} FAILED`) : ''}`);
  if (me?.trust) line(`${dim('trust')}    ${me.trust.max_inflight === 0 ? red('none') : `${me.trust.max_inflight} at a time, ${me.trust.sampling_rate >= 1 ? 'all re-run' : `${Math.round(me.trust.sampling_rate * 100)}% re-run`}`}`);
  const last = jobs.sort((a, b) => b.created_at - a.created_at)[0];
  if (last) line(`${dim('last job')} ${last.id.slice(0, 12)}… ${last.verdict === 'pass' ? green('verified') : last.verdict === 'fail' ? red('did not reproduce') : last.verdict === 'not_sampled' ? dim('not sampled') : yellow('checking')}`);
  if (lastErr) line(red(lastErr));
  process.stdout.write(`${ESC}H${out.map((s) => `${s}${ESC}K`).join('\n')}\n${ESC}J`);
}

process.stdout.write(`${ESC}2J${ESC}H${ESC}?25l`);
process.on('SIGINT', () => { process.stdout.write(`${ESC}?25h\n`); process.exit(0); });
await poll(); await pollCoord(); render();
setInterval(async () => { await poll(); render(); }, 1000);
setInterval(pollCoord, 3000);
setInterval(() => { tick++; render(); }, 150);
