// Ledger-gated bond withdrawal, step 1: produce the approver's EIP-712 WithdrawApproval.
//
// The registry only releases a bond with a signature from the approver address set at deploy.
// In production that approver is a hardware wallet. Three ways to get the signature:
//   --ledger  sign on a connected Ledger device (Ethereum app open). The device shows the
//             payload; the human approves. Uses @ledgerhq/hw-transport-node-hid + hw-app-eth,
//             loaded lazily so the script runs without a device or those packages installed.
//   --dev     sign with the software APPROVER_DEV_PRIVATE_KEY (testing without a device).
//   (none)    only print the typed data for an external EIP-712 signer (eth_signTypedData_v4).
// All three produce the same output; step 2 is scripts/withdraw-bond.mjs. See docs/LEDGER.md.
//
// Usage: node --env-file=.env scripts/approve-withdraw.mjs --provider 0x... --amount 0.01 [--dev | --ledger [--path "44'/60'/0'/0/0"]]
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { ethers } from 'ethers';
import { contracts, loadDeployment, rpcUrl, withdrawTypedData } from '../packages/shared/chain.mjs';

const DEFAULT_PATH = "44'/60'/0'/0/0";
const { values: a } = parseArgs({ options: {
  provider: { type: 'string' }, amount: { type: 'string' }, hours: { type: 'string', default: '1' },
  dev: { type: 'boolean', default: false }, ledger: { type: 'boolean', default: false }, path: { type: 'string', default: DEFAULT_PATH },
} });
if (!a.provider || !a.amount || (a.dev && a.ledger)) { console.error(`usage: --provider 0x... --amount <RLUSD> [--dev | --ledger [--path "${DEFAULT_PATH}"]]`); process.exit(1); }

const deployment = loadDeployment();
const provider = new ethers.JsonRpcProvider(rpcUrl(deployment));
const { registry } = contracts(provider, deployment);
const chainId = Number((await provider.getNetwork()).chainId);
const approver = ethers.getAddress(await registry.approver());
const nonce = await registry.withdrawNonce(a.provider);
const deadline = Math.floor(Date.now() / 1000) + Number(a.hours) * 3600;
const { domain, types } = withdrawTypedData(deployment, chainId);
// Decimal strings for the JSON shown to signers; BigInt for ethers' own signing/verification.
const message = { provider: ethers.getAddress(a.provider), amount: ethers.parseUnits(a.amount, 18).toString(), nonce: nonce.toString(), deadline };
const messageBig = { ...message, amount: BigInt(message.amount), nonce: BigInt(message.nonce) };
const typed = { domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...types }, primaryType: 'WithdrawApproval', message };

console.log('Approver on-chain:', approver);
console.log(`Chain ID ${chainId} (EIP-712 domain uses the deployed chain, deployments/testnet.json says ${deployment.chainId})`);
console.log('EIP-712 typed data to sign on the hardware wallet (eth_signTypedData_v4):');
console.log(JSON.stringify(typed, null, 1));

let signature, signerAddress, how;
if (a.dev) {
  if (!process.env.APPROVER_DEV_PRIVATE_KEY) throw new Error('APPROVER_DEV_PRIVATE_KEY missing');
  const signer = new ethers.Wallet(process.env.APPROVER_DEV_PRIVATE_KEY);
  signature = await signer.signTypedData(domain, types, messageBig);
  signerAddress = signer.address;
  how = '[dev] signed with the software approver key';
} else if (a.ledger) {
  ({ signature, address: signerAddress } = await signWithLedger(a.path));
  how = `[ledger] signed on the device at ${a.path}, address`;
}

if (signature) {
  // Never hand out a signature the contract would reject: recover locally first.
  const recovered = ethers.verifyTypedData(domain, types, messageBig, signature);
  if (recovered !== ethers.getAddress(signerAddress)) throw new Error(`signature recovers to ${recovered}, expected ${signerAddress}`);
  console.log(`\n${how} ${signerAddress}`);
  console.log(`signature verifies locally (recovers to ${recovered})${recovered === approver ? ', matches the on-chain approver' : ''}`);
  if (recovered !== approver) console.warn(`WARNING: ${recovered} is not the registry approver ${approver}; withdrawBond will revert "not approved" until the registry is redeployed with APPROVER_ADDRESS=${recovered} (docs/LEDGER.md).`);
  console.log(`\nnext: node --env-file=.env scripts/withdraw-bond.mjs --port <node port> --amount ${a.amount} --deadline ${deadline} --signature ${signature}`);
}

// Signs `typed` on a Ledger. Full EIP-712 (signEIP712Message) shows every field on the device;
// older firmware or an app that refuses an unknown chain without blind signing throws, and then
// the device signs the two EIP-712 hashes (domain separator + hashStruct) instead, which the
// Ethereum app only allows with blind signing enabled. Both paths yield the same 65-byte
// signature the registry's ecrecover expects.
async function signWithLedger(path) {
  const { TransportNodeHid, Eth } = loadLedger();
  if (!(await TransportNodeHid.isSupported())) throw new Error('node-hid is not usable on this machine');
  const devices = await TransportNodeHid.list(); // create() would wait for a device forever
  if (devices.length === 0) throw new Error('no Ledger device found: plug it in, unlock it and open the Ethereum app');
  const transport = await TransportNodeHid.open(devices[0]);
  try {
    const eth = new Eth(transport);
    const address = ethers.getAddress((await eth.getAddress(path)).address);
    console.log(`\n[ledger] device address at ${path}: ${address}`);
    if (address !== approver) {
      console.warn(`\n!!! WARNING: the device address ${address} is NOT the registry approver ${approver}.`);
      console.warn(`!!! The signature will be refused on-chain. Redeploy with APPROVER_ADDRESS=${address} (docs/LEDGER.md) or use --path for the matching account.\n`);
    }
    let sig;
    console.log('[ledger] review and approve the WithdrawApproval on the device...');
    try {
      sig = await eth.signEIP712Message(path, typed);
    } catch (error) {
      console.warn(`[ledger] full EIP-712 signing refused (${error.message}); falling back to hashed EIP-712 (needs blind signing enabled in the Ethereum app settings).`);
      const domainSeparator = ethers.TypedDataEncoder.hashDomain(domain);
      const hashStruct = ethers.TypedDataEncoder.from(types).hash(messageBig);
      console.log(`[ledger] domain separator ${domainSeparator}\n[ledger] message hash    ${hashStruct}`);
      sig = await eth.signEIP712HashedMessage(path, domainSeparator.slice(2), hashStruct.slice(2));
    }
    // The device returns v as 27/28 (or 0/1 on some firmware) and r, s as bare hex.
    const v = sig.v >= 27 ? sig.v : sig.v + 27;
    const signature = ethers.Signature.from({ r: '0x' + sig.r, s: '0x' + sig.s, v }).serialized;
    return { address, signature };
  } finally {
    await transport.close().catch(() => {});
  }
}

// The Ledger packages are optional and CommonJS-only in practice (their ESM builds use
// extensionless imports Node rejects), so load them lazily via require.
function loadLedger() {
  const require = createRequire(import.meta.url);
  try {
    return { TransportNodeHid: require('@ledgerhq/hw-transport-node-hid').default, Eth: require('@ledgerhq/hw-app-eth').default };
  } catch (error) {
    throw new Error(`Ledger packages unavailable (${error.message}). Install with: npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-eth`);
  }
}
