#!/usr/bin/env node
// Offline self-test for the coordinator's Quicknode Streams webhook.
//
// Fetches one real, recent VerdictPosted (or VoucherRedeemed) log from XRPL EVM Testnet, wraps
// it exactly the way a Quicknode Stream delivers it, and POSTs it to the coordinator's
// POST /webhooks/quicknode with the x-gradewire-secret header. Prints the HTTP status and body.
//
// Usage:  node --env-file=.env scripts/test-quicknode-webhook.mjs [--url http://127.0.0.1:4500/webhooks/quicknode]
//             [--dry-run] [--shape filtered|wrapped|raw] [--blocks 5000] [--event VerdictPosted|VoucherRedeemed]
//             [--tx 0x...]
//
//   --dry-run   print the payload that would be sent and exit (no HTTP request)
//   --shape     filtered  (default) the body our docs/QUICKNODE.md filter produces: a flat JSON
//                         array of raw log objects, e.g. [ {address, topics, data, ...} ]
//               wrapped   the same array under Quicknode's {data, metadata} envelope
//               raw       the UNFILTERED `logs` dataset envelope ({data: [[[log]]], metadata});
//                         the coordinator's current parser only flattens one level, so this is
//                         expected to answer {"handled":0} until it uses .flat(Infinity)
//   --tx        wrap the logs of this transaction instead of searching recent blocks
//
// Env: QUICKNODE_WEBHOOK_SECRET (sent as x-gradewire-secret; the coordinator checks it only when
//      the variable is set on its side), QUICKNODE_RPC_URL / AP4M_RPC_URL (RPC; falls back to the
//      public endpoint in deployments/testnet.json).
//
// Safe to run repeatedly: the coordinator de-duplicates every log by (transactionHash, logIndex)
// in its seen_logs table (packages/coordinator/index.mjs, handleLog), so re-sending a log it has
// already seen from its own RPC watcher, or from an earlier run of this script, is a no-op.
// Nothing here spends funds: it only reads logs and POSTs JSON to the coordinator.

import { parseArgs } from 'node:util';

import { ethers } from 'ethers';
import { PARTICIPANT_LEDGER_INTERFACE } from '@ap4m/sdk';

import { describeError, loadAbi, loadDeployment, logRange, makeProvider, rpcUrl } from '../packages/shared/chain.mjs';

const { values: args } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:4500/webhooks/quicknode' },
  'dry-run': { type: 'boolean', default: false },
  shape: { type: 'string', default: 'filtered' },
  blocks: { type: 'string', default: '5000' },
  event: { type: 'string', default: 'VerdictPosted' },
  tx: { type: 'string' },
} });

if (!['filtered', 'wrapped', 'raw'].includes(args.shape)) throw new Error('--shape must be filtered, wrapped or raw');
if (!['VerdictPosted', 'VoucherRedeemed'].includes(args.event)) throw new Error('--event must be VerdictPosted or VoucherRedeemed');

// Known transactions from the README proof table, used when the recent window holds no matching log.
const FALLBACK_TX = {
  VerdictPosted: '0xe35c677098e8f66e47bfd7eb5bf8ea67d868511df087438db9a8f406fc617b2f',
  VoucherRedeemed: '0xa9b9768e1ffb82256bdde171da9bbae3474febc1fab3fc9fe7653dcad7043da1',
};

const deployment = loadDeployment();
const provider = makeProvider(deployment);
// Quicknode's Discover plan caps eth_getLogs at 5 blocks, so a scan over thousands of blocks
// goes to the public RPC instead (the logs are identical; only the transport differs).
const scanUrl = logRange(rpcUrl(deployment)) < 2000 ? (process.env.AP4M_RPC_URL || deployment.rpcUrl) : rpcUrl(deployment);
const scanProvider = scanUrl === rpcUrl(deployment) ? provider : new ethers.JsonRpcProvider(scanUrl, deployment.chainId, { staticNetwork: true });
const smIface = new ethers.Interface(loadAbi('GradingServiceManager'));
const WATCHED = [deployment.serviceManager, deployment.registry, deployment.paymentLedger].map((a) => a.toLowerCase());
const TOPIC = {
  VerdictPosted: smIface.getEvent('VerdictPosted').topicHash,
  VoucherRedeemed: PARTICIPANT_LEDGER_INTERFACE.getEvent('VoucherRedeemed').topicHash,
};
const ADDRESS = { VerdictPosted: deployment.serviceManager, VoucherRedeemed: deployment.paymentLedger };
const hex = (n) => '0x' + BigInt(n).toString(16);

// A log object exactly as the Quicknode `logs` dataset carries it (numbers as hex strings).
function quicknodeLog(log) {
  return {
    address: log.address.toLowerCase(),
    topics: [...log.topics],
    data: log.data,
    blockNumber: hex(log.blockNumber),
    transactionHash: log.transactionHash,
    transactionIndex: hex(log.transactionIndex),
    blockHash: log.blockHash,
    logIndex: hex(log.index),
    removed: false,
  };
}

async function recentLogs(event, window) {
  const head = await provider.getBlockNumber();
  const found = [];
  // Scan backwards in 2000-block chunks (the public RPC rejects wider ranges) and stop at the first hit.
  for (let to = head; to > head - window && found.length === 0; to -= 2000) {
    const from = Math.max(deployment.deployBlock, to - 1999, head - window);
    const logs = await scanProvider.getLogs({ address: ADDRESS[event], topics: [TOPIC[event]], fromBlock: from, toBlock: to });
    if (logs.length) found.push(logs.at(-1));
  }
  return { head, logs: found };
}

async function txLogs(hash) {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) throw new Error(`no receipt for ${hash}`);
  const logs = receipt.logs.filter((l) => WATCHED.includes(l.address.toLowerCase()));
  if (!logs.length) throw new Error(`${hash} has no logs from the three watched contracts`);
  return logs;
}

function describe(log) {
  const addr = log.address.toLowerCase();
  try {
    if (addr === deployment.serviceManager.toLowerCase()) { const ev = smIface.parseLog({ topics: [...log.topics], data: log.data }); return `${ev.name}(${ev.args.map((a) => String(a)).join(', ')})`; }
    if (addr === deployment.paymentLedger.toLowerCase()) { const ev = PARTICIPANT_LEDGER_INTERFACE.parseLog({ topics: [...log.topics], data: log.data }); return `${ev.name} amount=${ethers.formatUnits(ev.args.amount, 18)} RLUSD`; }
  } catch { /* fall through */ }
  return `log from ${addr}`;
}

function wrap(shape, logs, head) {
  const metadata = {
    batch_end_range: Math.max(...logs.map((l) => l.blockNumber)),
    batch_start_range: Math.min(...logs.map((l) => l.blockNumber)),
    dataset: 'logs',
    network: 'xrpl-evm-testnet',
    stream_id: 'test-quicknode-webhook',
    stream_name: 'gradewire-events',
    stream_region: 'usa_east',
    keep_distance_from_tip: 0,
    latest_block: head,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const raw = logs.map(quicknodeLog);
  if (shape === 'filtered') return raw;                    // what our filter function returns
  if (shape === 'wrapped') return { data: raw, metadata }; // the same under Quicknode's envelope
  return { data: [[raw]], metadata };                      // unfiltered `logs` dataset: array of arrays of arrays
}

async function main() {
  let logs;
  let head = await provider.getBlockNumber();
  let origin;
  if (args.tx) { logs = await txLogs(args.tx); origin = `transaction ${args.tx}`; }
  else {
    const r = await recentLogs(args.event, Number(args.blocks));
    head = r.head;
    if (r.logs.length) { logs = r.logs; origin = `most recent ${args.event} in the last ${args.blocks} blocks (head ${head})`; }
    else { logs = await txLogs(FALLBACK_TX[args.event]); origin = `README proof transaction ${FALLBACK_TX[args.event]} (no ${args.event} in the last ${args.blocks} blocks)`; }
  }
  const payload = wrap(args.shape, logs, head);
  const body = JSON.stringify(payload);
  const secret = process.env.QUICKNODE_WEBHOOK_SECRET || '';

  console.log(`rpc:     ${rpcUrl(deployment)}${scanUrl !== rpcUrl(deployment) ? `  (history scan via ${scanUrl})` : ''}`);
  console.log(`source:  ${origin}`);
  for (const l of logs) console.log(`log:     ${describe(l)}  block ${l.blockNumber}  ${l.transactionHash}:${l.index}`);
  console.log(`shape:   ${args.shape}  (${body.length} bytes)`);
  console.log(`header:  x-gradewire-secret ${secret ? `set (${secret.length} chars)` : 'EMPTY: set QUICKNODE_WEBHOOK_SECRET or the coordinator answers 401 when it has one configured'}`);
  if (args['dry-run']) {
    console.log(`\nwould POST ${args.url} with body:\n${JSON.stringify(payload, null, 2)}`);
    return;
  }
  const res = await fetch(args.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gradewire-secret': secret }, body });
  const text = await res.text();
  console.log(`\nPOST ${args.url} -> HTTP ${res.status}\n${text}`);
  if (res.ok) console.log(/"handled":0/.test(text) ? '(handled 0: every log was already seen by the coordinator, or the shape was not unwrapped; both are expected for raw/duplicate sends)' : 'ok: the coordinator accepted the log(s) as source "quicknode"');
  process.exitCode = res.ok ? 0 : 1;
}

main().catch((error) => { console.error(describeError(error)); process.exit(1); });
