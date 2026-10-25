// Creates identities for provider nodes (ports given as args) if missing, and funds each with
// testnet XRP (gas, from the agent wallet) and RLUSD (bond, from the team payout wallet).
// Usage: node --env-file=.env scripts/fund-nodes.mjs 4401 4402 4403
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { contracts, loadDeployment, rpcUrl } from '../packages/shared/chain.mjs';

const ports = process.argv.slice(2);
if (!ports.length) { console.error('usage: fund-nodes.mjs <port> [port...]'); process.exit(1); }
const deployment = loadDeployment();
const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
const agent = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const payout = new ethers.Wallet(process.env.MERCHANT_PRIVATE_KEY, provider);
const { rlusd } = contracts(provider, deployment);
const XRP = ethers.parseEther(process.env.NODE_XRP || '3');
const BOND = ethers.parseUnits(process.env.BOND_RLUSD || '0.01', 18);
console.log(`payout wallet holds ${ethers.formatUnits(await rlusd.balanceOf(payout.address), 18)} RLUSD`);
for (const port of ports) {
  const dir = `.state/node-${port}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${dir}/identity.json`;
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ privateKey: ethers.Wallet.createRandom().privateKey }), { mode: 0o600 });
  const addr = new ethers.Wallet(JSON.parse(readFileSync(file, 'utf8')).privateKey).address;
  const xrp = await provider.getBalance(addr);
  if (xrp < XRP / 2n) await (await agent.sendTransaction({ to: addr, value: XRP - xrp })).wait();
  const rl = await rlusd.balanceOf(addr);
  if (rl < BOND) await (await rlusd.connect(payout).transfer(addr, BOND - rl)).wait();
  console.log(`node-${port} ${addr}  XRP ${ethers.formatEther(await provider.getBalance(addr))}  RLUSD ${ethers.formatUnits(await rlusd.balanceOf(addr), 18)}`);
}
