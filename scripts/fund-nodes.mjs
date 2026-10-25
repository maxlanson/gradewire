// Funds provider nodes with testnet XRP (gas, from the agent wallet) and RLUSD (bond, from the
// team payout wallet). Local nodes are named by port (their identity lives in .state/node-<port>,
// created here if missing); a node joining from another laptop is funded by the address it prints.
// Usage: node --env-file=.env scripts/fund-nodes.mjs 4401 4402 4403
//        node --env-file=.env scripts/fund-nodes.mjs --address 0xabc... [--address 0xdef...]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { contracts, loadDeployment, makeProvider } from '../packages/shared/chain.mjs';

const args = process.argv.slice(2);
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--address') targets.push({ address: ethers.getAddress(args[++i]), name: 'remote' });
  else if (/^\d+$/.test(args[i])) targets.push({ port: args[i], name: `node-${args[i]}` });
  else { console.error(`unknown argument ${args[i]}`); process.exit(1); }
}
if (!targets.length) { console.error('usage: fund-nodes.mjs <port> [port...] | --address 0x... [--address 0x...]'); process.exit(1); }
const deployment = loadDeployment();
const provider = makeProvider(deployment);
const agent = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const payout = new ethers.Wallet(process.env.MERCHANT_PRIVATE_KEY, provider);
const { rlusd } = contracts(provider, deployment);
const XRP = ethers.parseEther(process.env.NODE_XRP || '3');
const BOND = ethers.parseUnits(process.env.BOND_RLUSD || '0.01', 18);
console.log(`payout wallet holds ${ethers.formatUnits(await rlusd.balanceOf(payout.address), 18)} RLUSD; agent wallet ${ethers.formatEther(await provider.getBalance(agent.address))} XRP`);
for (const t of targets) {
  let addr = t.address;
  if (t.port) {
    const dir = `.state/node-${t.port}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${dir}/identity.json`;
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ privateKey: ethers.Wallet.createRandom().privateKey }), { mode: 0o600 });
    addr = new ethers.Wallet(JSON.parse(readFileSync(file, 'utf8')).privateKey).address;
  }
  const xrp = await provider.getBalance(addr);
  if (xrp < XRP / 2n) await (await agent.sendTransaction({ to: addr, value: XRP - xrp })).wait();
  const rl = await rlusd.balanceOf(addr);
  if (rl < BOND) await (await rlusd.connect(payout).transfer(addr, BOND - rl)).wait();
  console.log(`${t.name} ${addr}  XRP ${ethers.formatEther(await provider.getBalance(addr))}  RLUSD ${ethers.formatUnits(await rlusd.balanceOf(addr), 18)}`);
}
