// Prints the address a connected Ledger device holds at a BIP-32 path, for use as the registry's
// APPROVER_ADDRESS at deploy time (docs/LEDGER.md). Compares it with the current on-chain approver.
// Touches no funds and signs nothing; --display also shows the address on the device for a visual check.
//
// Usage: node --env-file=.env scripts/ledger-address.mjs [--path "44'/60'/0'/0/0"] [--display]
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { ethers } from 'ethers';
import { contracts, loadDeployment, rpcUrl } from '../packages/shared/chain.mjs';

const { values: a } = parseArgs({ options: { path: { type: 'string', default: "44'/60'/0'/0/0" }, display: { type: 'boolean', default: false } } });
const require = createRequire(import.meta.url);
let TransportNodeHid, Eth;
try {
  ({ default: TransportNodeHid } = require('@ledgerhq/hw-transport-node-hid'));
  ({ default: Eth } = require('@ledgerhq/hw-app-eth'));
} catch (error) {
  console.error(`Ledger packages unavailable (${error.message}). Install with: npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-eth`);
  process.exit(1);
}
const devices = await TransportNodeHid.list();
if (devices.length === 0) { console.error('no Ledger device found: plug it in, unlock it and open the Ethereum app'); process.exit(1); }
const transport = await TransportNodeHid.open(devices[0]);
try {
  const { address } = await new Eth(transport).getAddress(a.path, a.display);
  const checksummed = ethers.getAddress(address);
  console.log(`Ledger address at ${a.path}: ${checksummed}`);
  const deployment = loadDeployment();
  const approver = ethers.getAddress(await contracts(new ethers.JsonRpcProvider(rpcUrl(deployment)), deployment).registry.approver());
  if (checksummed === approver) console.log('This address is the registry approver: --ledger approvals will be accepted on-chain.');
  else console.log(`Registry approver is ${approver}. To make the device the approver, redeploy with APPROVER_ADDRESS=${checksummed} (docs/LEDGER.md).`);
} finally {
  await transport.close().catch(() => {});
}
