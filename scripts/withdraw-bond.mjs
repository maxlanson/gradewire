// Ledger-gated bond withdrawal, step 2: the provider node submits withdrawBond with the
// approver's signature from scripts/approve-withdraw.mjs. Without a valid approval the
// registry reverts ("not approved"), so a stolen node key alone cannot drain the bond.
//
// Usage: node --env-file=.env scripts/withdraw-bond.mjs --port 4401 --amount 0.01 --deadline <unix> --signature 0x...
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ethers } from 'ethers';
import { contracts, loadDeployment, rpcUrl } from '../packages/shared/chain.mjs';

const { values: a } = parseArgs({ options: { port: { type: 'string', default: '4401' }, amount: { type: 'string' }, deadline: { type: 'string' }, signature: { type: 'string' } } });
if (!a.amount || !a.deadline || !a.signature) { console.error('usage: --port 4401 --amount <RLUSD> --deadline <unix> --signature 0x...'); process.exit(1); }
const deployment = loadDeployment();
const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
const identity = new ethers.Wallet(JSON.parse(readFileSync(`.state/node-${a.port}/identity.json`, 'utf8')).privateKey, provider);
const { registry, rlusd } = contracts(provider, deployment);
const before = await rlusd.balanceOf(identity.address);
try {
  const tx = await registry.connect(identity).withdrawBond(ethers.parseUnits(a.amount, 18), Number(a.deadline), a.signature);
  const receipt = await tx.wait();
  console.log(`withdrawn ${a.amount} RLUSD to ${identity.address}: ${deployment.explorerUrl}/tx/${receipt.hash}`);
  console.log(`node RLUSD ${ethers.formatUnits(before, 18)} → ${ethers.formatUnits(await rlusd.balanceOf(identity.address), 18)}`);
} catch (error) {
  console.error('withdrawal refused:', error.reason ?? error.shortMessage ?? error.message);
  process.exit(1);
}
