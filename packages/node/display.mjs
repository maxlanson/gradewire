// Live terminal panel for a node, so the laptop running it shows what it is doing: identity,
// on-chain status and earned trust, jobs it has run and been paid for, which ones the verifiers
// re-ran, and the last few log lines. Only active on a TTY; under scripts/demo-up.sh (logs to
// files) the node keeps its plain log lines.

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ESC = '\x1b[';
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const green = (s) => `${ESC}32m${s}${ESC}39m`;
const red = (s) => `${ESC}31m${s}${ESC}39m`;
const yellow = (s) => `${ESC}33m${s}${ESC}39m`;
const short = (h) => (h ? `${h.slice(0, 10)}…` : '');

export function createDisplay({ label, address, publicUrl, price, cheat, enabled = process.stdout.isTTY }) {
  const state = { status: 'starting', bond: null, trust: null, score: null, note: '', jobs: new Map(), logs: [], tick: 0, startedAt: Date.now(), earned: 0 };
  if (!enabled) {
    return { event() {}, log(line) { console.log(line); }, stop() {}, enabled: false };
  }
  const original = { log: console.log, error: console.error, warn: console.warn };
  const capture = (kind) => (...parts) => {
    const line = parts.map((p) => (typeof p === 'string' ? p : String(p?.message ?? p))).join(' ');
    state.logs.push({ kind, line, at: Date.now() });
    if (state.logs.length > 200) state.logs.shift();
  };
  console.log = capture('log'); console.error = capture('error'); console.warn = capture('warn');

  function render() {
    const width = Math.max(60, process.stdout.columns || 100);
    const rows = Math.max(20, process.stdout.rows || 30);
    const out = [];
    const line = (s = '') => out.push(s);
    const running = [...state.jobs.values()].filter((j) => j.phase === 'running');
    const frame = SPIN[state.tick % SPIN.length];
    const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
    const hhmm = `${String(Math.floor(uptime / 3600)).padStart(2, '0')}:${String(Math.floor((uptime % 3600) / 60)).padStart(2, '0')}:${String(uptime % 60).padStart(2, '0')}`;

    line(`${bold('GRADEWIRE NODE')}  ${bold(label)}${cheat ? red('  CHEAT MODE: returns fabricated output') : ''}   ${dim(`up ${hhmm}`)}`);
    line(`${dim('identity')}  ${address}`);
    line(`${dim('selling')}   ${publicUrl}/grade/{job_id} at ${price} RLUSD per job`);
    const statusText = state.status === 'active' ? green('active') : state.status === 'suspended' ? red('suspended, bond slashed') : yellow(state.status);
    line(`${dim('status')}    ${statusText}${state.bond != null ? `  bond ${state.bond} RLUSD` : ''}${state.score != null ? `  reliability ${state.score.toFixed(2)}` : ''}${state.trust ? `  trust: ${describeTrust(state.trust)}` : ''}`);
    if (state.note) line(`${dim('note')}      ${state.note}`);
    line();
    const jobs = [...state.jobs.values()];
    const paid = jobs.filter((j) => j.paid_tx).length;
    const verified = jobs.filter((j) => j.verdict === 'pass').length;
    const failed = jobs.filter((j) => j.verdict === 'fail').length;
    const checking = jobs.filter((j) => j.sampled && !j.verdict).length;
    line(`${bold(String(paid))} paid jobs   ${bold(green(`${state.earned.toFixed(2)} RLUSD`))} earned   ${bold(String(verified))} verified by re-run   ${checking ? yellow(`${checking} being checked`) : dim('0 being checked')}   ${failed ? red(`${failed} failed`) : dim('0 failed')}`);
    line();
    if (running.length) line(`${green(frame)} running ${running.map((j) => `${j.id} (${((Date.now() - j.startedAt) / 1000).toFixed(1)} s)`).join(', ')}`);
    else if (state.status === 'active') line(`${dim(SPIN[state.tick % SPIN.length])} ${dim('listening for the next paid job…')}`);
    else line(`${yellow(frame)} ${dim(state.status === 'starting' ? 'joining the network…' : 'not taking jobs')}`);
    line();
    line(dim('recent jobs'.padEnd(20) + 'ran'.padStart(8) + '  paid'.padEnd(16) + 'verification'));
    const recent = jobs.slice(-8).reverse();
    if (!recent.length) line(dim('  none yet'));
    for (const j of recent) {
      const ran = j.ms != null ? `${j.ms} ms` : j.phase === 'running' ? '…' : '';
      const paidText = j.paid_tx ? green(`${j.price} RLUSD`) : dim('—');
      const v = j.verdict === 'pass' ? green('✓ verified, hashes match') : j.verdict === 'fail' ? red('✗ FAILED: result did not reproduce') : j.sampled ? yellow('⟳ 3 verifiers re-running it') : j.sampled === false ? dim('not sampled this time') : dim('reporting…');
      line(`  ${j.id.padEnd(18)}${ran.padStart(8)}  ${paidText.padEnd(16 + 10)}${v}`);
    }
    line();
    line(dim('log'));
    const logRows = Math.max(3, rows - out.length - 2);
    for (const l of state.logs.slice(-logRows)) {
      const t = new Date(l.at).toTimeString().slice(0, 8);
      const text = l.line.length > width - 10 ? l.line.slice(0, width - 11) + '…' : l.line;
      line(`  ${dim(t)} ${l.kind === 'error' ? red(text) : l.kind === 'warn' ? yellow(text) : text}`);
    }
    process.stdout.write(`${ESC}H${out.map((s) => `${s}${ESC}K`).join('\n')}\n${ESC}J`);
  }

  process.stdout.write(`${ESC}2J${ESC}H${ESC}?25l`);
  const timer = setInterval(() => { state.tick++; render(); }, 250);
  timer.unref();
  render();

  function event(type, d = {}) {
    if (type === 'status') Object.assign(state, d);
    else if (type === 'job-start') state.jobs.set(d.id, { id: d.id, phase: 'running', startedAt: Date.now(), price: d.price });
    else if (type === 'job-done') { const j = state.jobs.get(d.id); if (j) Object.assign(j, { phase: 'done', ms: d.ms, paid_tx: d.paid_tx, status: d.status }); if (d.paid_tx) state.earned += Number(d.price || 0); }
    else if (type === 'job-reported') { const j = state.jobs.get(d.id); if (j) j.sampled = d.sampled; }
    else if (type === 'job-verdict') { const j = state.jobs.get(d.id); if (j) j.verdict = d.verdict; }
    render();
  }
  function stop() { clearInterval(timer); process.stdout.write(`${ESC}?25h\n`); Object.assign(console, original); }
  return { event, log: (line) => console.log(line), stop, enabled: true };
}

function describeTrust(t) {
  if (!t) return '';
  if (t.max_inflight === 0) return 'none';
  return `${t.max_inflight} job${t.max_inflight === 1 ? '' : 's'} at a time, ${t.sampling_rate >= 1 ? 'every one re-run' : `${Math.round(t.sampling_rate * 100)}% re-run`}`;
}
