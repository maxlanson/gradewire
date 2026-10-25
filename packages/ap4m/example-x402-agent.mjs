/**
 * AP4M Hackathon — Example x402 Agent
 * FOR HACKATHON USE ONLY
 *
 * Opens a Channel to a Merchant, buys its resource with an x402 payment, then asks the
 * AP4M service to pay the Merchant and close the Channel.
 *
 * Prerequisites (Node.js 22.13 or later), in the same directory:
 *   npm install ethers@6.17.0 <AP4M_API_URL>/sdk/ap4m-sdk.tgz
 *   curl -O <AP4M_API_URL>/sdk/ap4m-x402.mjs -O <AP4M_API_URL>/sdk/ap4m-hackathon-sdk.cjs
 *
 * Usage:
 *   AGENT_PRIVATE_KEY=0x... TEAM_NAME="Your Team" RESOURCE_URL=https://merchant.example/resource node example-x402-agent.mjs
 */

import { ethers } from 'ethers';
import hackathonSdk from './ap4m-hackathon-sdk.cjs';
import { buyResource, loadX402Context } from './ap4m-x402.mjs';

const { signIn, requestChannel, settle, closeChannel } = hackathonSdk;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILL THESE IN — copy from your participant portal
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || '';
//  ^ Your agent wallet private key; it needs gas to request a Channel.
const TEAM_NAME = process.env.TEAM_NAME || 'Your Team Name';
const AP4M_API_URL = process.env.AP4M_API_URL || 'http://YOUR_API_URL_HERE';
const RESOURCE_URL = process.env.RESOURCE_URL || 'http://127.0.0.1:4308/resource';
//  ^ The Merchant's /resource URL.
const MERCHANT_ID = process.env.MERCHANT_ID || '';
//  ^ The Merchant to pay; defaults to your team's Merchant. Another team's works only when
//    the organizers turn on cross-team payments.
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const CHANNEL_CAP = process.env.CHANNEL_CAP || '5';
//  ^ Leave CHANNEL_ID empty to open a Channel with a CHANNEL_CAP RLUSD spending limit.
const MAXIMUM_PRICE = process.env.MAXIMUM_PRICE || '1';
//  ^ Highest price in RLUSD this agent accepts for the resource.
const OPERATION = process.env.OPERATION || 'first-purchase';
//  ^ Name of this purchase; rerun with the same name to resume it, use a new name to buy again.
const STATE_DIRECTORY = process.env.STATE_DIRECTORY || './agent-state';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  if (!AGENT_PRIVATE_KEY) {
    console.error('Set AGENT_PRIVATE_KEY (see the top of this file).');
    process.exit(1);
  }
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
  const agentWallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);
  const context = await loadX402Context(AP4M_API_URL);

  console.log('[1] Signing in...');
  const { token } = await signIn(AP4M_API_URL, TEAM_NAME, agentWallet);

  let channelId = CHANNEL_ID;
  if (!channelId) {
    console.log(`[2] Requesting a Channel with a ${CHANNEL_CAP} RLUSD limit...`);
    const channel = await requestChannel(AP4M_API_URL, token, agentWallet, { capRlusd: CHANNEL_CAP, merchantId: MERCHANT_ID || undefined });
    channelId = channel.channel_id;
  }
  console.log('Channel:', channelId);

  console.log('[3] Buying the resource...');
  const purchase = await buyResource({
    context, provider, wallet: agentWallet, stateDirectory: STATE_DIRECTORY, resourceUrl: RESOURCE_URL,
    channelId, maximumAmount: ethers.parseUnits(MAXIMUM_PRICE, 18).toString(), operation: OPERATION,
  });
  console.log('Resource:', JSON.stringify(purchase.resource));
  console.log('Redeemed by the Merchant. TX:', purchase.transactionHash);

  console.log('[4] Reporting the payment and settling...');
  const recordResp = await fetch(`${AP4M_API_URL}/public/participant/record-redemption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ tx_hash: purchase.transactionHash }),
  });
  if (!recordResp.ok) throw new Error(`record-redemption failed: ${(await recordResp.json()).error}`);
  const settled = await settle(AP4M_API_URL, token, channelId);
  console.log('RLUSD paid to the Merchant. TX:', settled.payout_tx);
  if (settled.receipt_url) console.log('Verifiable receipt:', AP4M_API_URL + settled.receipt_url);

  console.log('[5] Closing the Channel...');
  const closed = await closeChannel(AP4M_API_URL, token, agentWallet, channelId);
  console.log('Channel closed. TX:', closed.tx_hash);
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
