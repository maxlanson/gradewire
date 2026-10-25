/**
 * AP4M Hackathon — Example x402 Merchant
 * FOR HACKATHON USE ONLY
 *
 * Sells one fixed-price JSON resource at GET /resource. Agents pay with a Voucher on a
 * Channel to your team's Merchant; this server redeems each Voucher on-chain and returns
 * the resource.
 *
 * Prerequisites (Node.js 22.13 or later):
 *   npm install ethers@6.17.0 <AP4M_API_URL>/sdk/ap4m-sdk.tgz
 *
 * Usage:
 *   MERCHANT_SUBMITTER_KEY=0x... MERCHANT_ID=0x... MERCHANT_PAYOUT=0x... node example-x402-merchant.mjs
 */

import { ethers } from 'ethers';
import { createX402Merchant, loadX402Context } from './ap4m-x402.mjs';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILL THESE IN — copy from your participant portal
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const AP4M_API_URL = process.env.AP4M_API_URL || 'http://YOUR_API_URL_HERE';
const MERCHANT_ID = process.env.MERCHANT_ID || '';
//  ^ Your Merchant ID (participant portal, My setup tab, or GET /public/participant/me).
const MERCHANT_PAYOUT = process.env.MERCHANT_PAYOUT || '';
//  ^ Your Merchant payout wallet; RLUSD is paid here at settlement.
const MERCHANT_SUBMITTER_KEY = process.env.MERCHANT_SUBMITTER_KEY || '';
//  ^ Private key of a wallet with gas that sends redemptions (your payout wallet works).
const PRICE_RLUSD = process.env.PRICE_RLUSD || '1';
const PORT = Number(process.env.PORT || 4308);
const RESOURCE_URL = process.env.RESOURCE_URL || `http://127.0.0.1:${PORT}/resource`;
//  ^ The URL Agents call. Use your public HTTPS URL when the Merchant is not local.
const STATE_DIRECTORY = process.env.STATE_DIRECTORY || './merchant-state';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  if (!MERCHANT_ID || !MERCHANT_PAYOUT || !MERCHANT_SUBMITTER_KEY) {
    console.error('Set MERCHANT_ID, MERCHANT_PAYOUT and MERCHANT_SUBMITTER_KEY (see the top of this file).');
    process.exit(1);
  }
  const context = await loadX402Context(AP4M_API_URL);
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
  const merchant = createX402Merchant({
    context,
    provider,
    submitter: new ethers.Wallet(MERCHANT_SUBMITTER_KEY, provider),
    stateDirectory: STATE_DIRECTORY,
    resourceUrl: RESOURCE_URL,
    merchantParticipantId: MERCHANT_ID,
    payout: MERCHANT_PAYOUT,
    amount: ethers.parseUnits(PRICE_RLUSD, 18).toString(),
    content: { message: 'Hello from an AP4M x402 Merchant', servedAt: 'purchase' },
  });
  // Loopback only; put HTTPS (a tunnel or reverse proxy) in front to serve Agents on other machines.
  merchant.server.listen(PORT, '127.0.0.1', () => console.log(`Merchant selling ${RESOURCE_URL} for ${PRICE_RLUSD} RLUSD`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { merchant.close().finally(() => process.exit(0)); });
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
