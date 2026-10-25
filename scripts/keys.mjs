// Generates the coordinator, three verifier operator keys and a dev approver key into .env
// (if missing), never printing a private key, and funds them with testnet XRP from the agent.
import { appendFileSync, readFileSync } from 'node:fs';
import { ethers } from 'ethers';

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const names = ['COORDINATOR', 'OPERATOR1', 'OPERATOR2', 'OPERATOR3', 'APPROVER_DEV'];
const fund = { COORDINATOR: '8', OPERATOR1: '3', OPERATOR2: '3', OPERATOR3: '3', APPROVER_DEV: '0' };
let added = '';
for (const n of names) {
  if (!env[`${n}_PRIVATE_KEY`]) {
    const w = ethers.Wallet.createRandom();
    added += `${n}_PRIVATE_KEY=${w.privateKey}\n${n}_ADDRESS=${w.address}\n`;
    env[`${n}_PRIVATE_KEY`] = w.privateKey; env[`${n}_ADDRESS`] = w.address;
  }
}
if (added) appendFileSync('.env', (readFileSync('.env', 'utf8').endsWith('\n') ? '' : '\n') + added);
const provider = new ethers.JsonRpcProvider('https://rpc.testnet.xrplevm.org');
const agent = new ethers.Wallet(env.AGENT_PRIVATE_KEY, provider);
for (const n of names) {
  const addr = env[`${n}_ADDRESS`];
  const bal = await provider.getBalance(addr);
  const want = ethers.parseEther(fund[n]);
  if (bal < want / 2n && want > 0n) {
    const tx = await agent.sendTransaction({ to: addr, value: want - bal });
    await tx.wait();
  }
  console.log(n.padEnd(13), addr, 'XRP', ethers.formatEther(await provider.getBalance(addr)));
}
console.log('agent XRP left', ethers.formatEther(await provider.getBalance(agent.address)));
