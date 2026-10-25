// Chain access shared by coordinator, verifiers, nodes and the trainer: deployment addresses,
// ABIs, EIP-712 typed data for verifier responses and bond-withdrawal approvals.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ethers } from 'ethers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadDeployment() {
  return JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
}

export function loadAbi(name) {
  return JSON.parse(readFileSync(resolve(ROOT, `deployments/abi/${name}.json`), 'utf8'));
}

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// Quicknode's endpoint is preferred when configured; the public RPC is the fallback.
export function rpcUrl(deployment) {
  return process.env.QUICKNODE_RPC_URL || process.env.AP4M_RPC_URL || deployment.rpcUrl;
}

export function contracts(provider, deployment = loadDeployment()) {
  return {
    deployment,
    registry: new ethers.Contract(deployment.registry, loadAbi('GradewireRegistry'), provider),
    serviceManager: new ethers.Contract(deployment.serviceManager, loadAbi('GradingServiceManager'), provider),
    rlusd: new ethers.Contract(deployment.rlusd, ERC20_ABI, provider),
  };
}

// bytes32 job id for on-chain use: keccak256 of the job_id string.
export const jobIdBytes = (jobId) => ethers.id(jobId);
export const hex32 = (sha256Hex) => '0x' + sha256Hex;

export function responseTypedData(deployment, chainId) {
  return {
    domain: { name: 'GradingServiceManager', version: '1', chainId, verifyingContract: deployment.serviceManager },
    types: { TaskResponse: [{ name: 'taskId', type: 'uint32' }, { name: 'matched', type: 'bool' }, { name: 'operatorHash', type: 'bytes32' }] },
  };
}

export function withdrawTypedData(deployment, chainId) {
  return {
    domain: { name: 'GradewireRegistry', version: '1', chainId, verifyingContract: deployment.registry },
    types: { WithdrawApproval: [{ name: 'provider', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  };
}

export const STATUS = ['none', 'registered', 'active', 'suspended'];

// ── RPC providers ─────────────────────────────────────────────────────────────
// Quicknode's Discover plan answers eth_getLogs only for ranges of at most 5 blocks
// (measured Oct 25 2026: toBlock - fromBlock = 5 works, 6 returns -32615). The public RPC
// takes 2000. Every process gets its provider from makeProvider(), which splits wider
// ranges into sequential chunks so pollers, resumes and the AP4M merchant helper's
// VoucherRedeemed lookup all work unchanged on either endpoint.
export function logRange(url = rpcUrl(loadDeployment())) {
  try { if (new URL(url).hostname.endsWith('.quiknode.pro')) return 5; } catch { /* not a URL */ }
  return 2000;
}

// Inclusive [from, to] split into [a, b] pairs with b - a <= span.
export function splitRange(from, to, span) {
  const out = [];
  for (let a = from; a <= to; a += span + 1) out.push([a, Math.min(to, a + span)]);
  return out;
}

const RATE_LIMIT_TEXT = /rate ?limit|too many requests|request limit|limit reached|credits/i;
function rateLimited(error) {
  const rpc = error?.info?.error;
  if (rpc && typeof rpc === 'object' && (rpc.code === -32007 || rpc.code === -32029 || RATE_LIMIT_TEXT.test(String(rpc.message ?? '')))) return true;
  const status = error?.info?.response?.statusCode;
  return status === 429 || /server response 429/i.test(String(error?.message ?? ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ChunkedLogsProvider extends ethers.JsonRpcProvider {
  #span;
  #limitedUntil = 0;
  constructor(url, chainId, span) {
    super(url, chainId, { staticNetwork: true });
    this.#span = span;
  }
  // The public RPC is load-balanced: a block number read from one backend can be unknown to
  // another for a few seconds, and ethers returns null. The AP4M merchant helper treats a null
  // block as "finalized block is unavailable" and refuses the payment, so retry briefly.
  async getBlock(tag, prefetchTxs) {
    for (let attempt = 0; ; attempt++) {
      const block = await super.getBlock(tag, prefetchTxs);
      if (block || typeof toBlockNumber(tag) !== 'number' || attempt >= 6) return block;
      await sleep(500);
    }
  }
  async getLogs(filter) {
    const from = toBlockNumber(filter?.fromBlock);
    const to = toBlockNumber(filter?.toBlock);
    if (from === undefined || to === undefined || to - from <= this.#span) return super.getLogs(filter);
    const logs = [];
    for (const [a, b] of splitRange(from, to, this.#span)) {
      if (logs.length || a !== from) await sleep(120); // ~8 chunks/s leaves headroom for the other processes on the same key
      logs.push(...await super.getLogs({ ...filter, fromBlock: a, toBlock: b }));
    }
    return logs;
  }
  // Seven processes share one Quicknode key during a demo; a burst (a catch-up after a restart,
  // three verifiers polling at once) can trip the plan's per-second limit. Retry those with
  // backoff instead of surfacing them as failed polls or failed transactions.
  async _send(payload) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.#limitedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      let result;
      try {
        result = await super._send(payload);
      } catch (error) {
        if (!rateLimited(error) || attempt >= 6) throw error;
        result = null;
      }
      if (result && !result.some((r) => r.error && rateLimited({ info: { error: r.error } }))) return result;
      if (result && attempt >= 6) return result;
      const backoff = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
      this.#limitedUntil = Date.now() + backoff;
      if (attempt === 0) console.error(`[rpc] rate limited by ${new URL(this._getConnection().url).hostname}; backing off`);
    }
  }
}

function toBlockNumber(tag) {
  if (typeof tag === 'number') return tag;
  if (typeof tag === 'bigint') return Number(tag);
  if (typeof tag === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(tag)) return Number(tag);
  return undefined; // 'latest', 'safe', undefined: let ethers resolve it in one call
}

export function makeProvider(deployment = loadDeployment()) {
  const url = rpcUrl(deployment);
  return new ChunkedLogsProvider(url, deployment.chainId, logRange(url));
}

// Log text for an error: ethers' shortMessage plus the JSON-RPC error behind it, because
// "could not coalesce error" on its own says nothing about what the RPC refused.
export function describeError(error) {
  if (!error || typeof error !== 'object') return String(error);
  let text = error.shortMessage ?? error.message ?? String(error);
  const rpc = error.info?.error;
  const payload = error.info?.payload;
  const method = Array.isArray(payload) ? payload.map((p) => p?.method).join(',') : payload?.method;
  if (rpc && typeof rpc === 'object' && rpc.message) text += ` [rpc ${rpc.code ?? '?'}: ${String(rpc.message).slice(0, 160)}${method ? ` on ${method}` : ''}]`;
  else if (error.info?.response?.statusCode) text += ` [http ${error.info.response.statusCode}${method ? ` on ${method}` : ''}]`;
  return text;
}
