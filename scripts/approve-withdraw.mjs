// Ledger-gated bond withdrawal, step 1: produce the approver's EIP-712 WithdrawApproval.
//
// The registry only releases a bond with a signature from the approver address set at deploy.
// In production that approver is a hardware wallet: this script prints the exact EIP-712
// payload to sign on the device (Ledger Live / any EIP-712-capable signer) and, with
// --dev, signs it with the software APPROVER_DEV key instead so the flow can be tested
// without a device. Step 2 is scripts/withdraw-bond.mjs.
//
// Usage: node --env-file=.env scripts/approve-withdraw.mjs --provider 0x... --amount 0.01 [--dev]
import { parseArgs } from 'node:util';
import { ethers } from 'ethers';
import { contracts, loadDeployment, rpcUrl, withdrawTypedData } from '../packages/shared/chain.mjs';

const { values: a } = parseArgs({ options: { provider: { type: 'string' }, amount: { type: 'string' }, dev: { type: 'boolean', default: false }, hours: { type: 'string', default: '1' } } });
if (!a.provider || !a.amount) { console.error('usage: --provider 0x... --amount <RLUSD> [--dev]'); process.exit(1); }
const deployment = loadDeployment();
const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
const { registry } = contracts(provider, deployment);
const nonce = await registry.withdrawNonce(a.provider);
const deadline = Math.floor(Date.now() / 1000) + Number(a.hours) * 3600;
const { domain, types } = withdrawTypedData(deployment, Number((await provider.getNetwork()).chainId));
const message = { provider: ethers.getAddress(a.provider), amount: ethers.parseUnits(a.amount, 18).toString(), nonce: nonce.toString(), deadline };
const typed = { domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...types }, primaryType: 'WithdrawApproval', message };
console.log('Approver on-chain:', await registry.approver());
console.log('EIP-712 typed data to sign on the hardware wallet (eth_signTypedData_v4):');
console.log(JSON.stringify(typed, null, 1));
if (a.dev) {
  if (!process.env.APPROVER_DEV_PRIVATE_KEY) throw new Error('APPROVER_DEV_PRIVATE_KEY missing');
  const signer = new ethers.Wallet(process.env.APPROVER_DEV_PRIVATE_KEY);
  const signature = await signer.signTypedData(domain, types, { ...message, amount: BigInt(message.amount), nonce: BigInt(message.nonce) });
  console.log('\n[dev] signed with the software approver key', signer.address);
  console.log(`\nnext: node --env-file=.env scripts/withdraw-bond.mjs --port <node port> --amount ${a.amount} --deadline ${deadline} --signature ${signature}`);
}
