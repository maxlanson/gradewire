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
