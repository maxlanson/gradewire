// List or close the team's AP4M Channels. The service allows three open Channels per payout.
// Usage: node --env-file=.env scripts/channels.mjs            # list
//        node --env-file=.env scripts/channels.mjs close 0x…  # settle (best effort) and close one
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const sdk = createRequire(import.meta.url)('../packages/ap4m/ap4m-hackathon-sdk.cjs');
const api = (process.env.AP4M_API_URL || 'https://hackathon.ap4m.build').replace(/\/$/, '');
const config = await (await fetch(`${api}/public/config`)).json();
const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const { token } = await sdk.signIn(api, process.env.TEAM_NAME || 'FranksDAO', wallet);
const [cmd, id] = process.argv.slice(2);

if (cmd === 'close' && id) {
  try { const s = await sdk.settle(api, token, id); console.log(`settled ${s.claims_settled} claims`); } catch (e) { console.log(`settle: ${e.message}`); }
  const closed = await sdk.closeChannel(api, token, wallet, id);
  console.log(`closed ${id}: ${config.network.explorerUrl}/tx/${closed.tx_hash}`);
} else {
  for (const c of await sdk.listChannels(api, token)) {
    let state = '';
    try { const s = await sdk.getChannelState(provider, config.contracts.paymentLedger, c.channel_id); state = `cap ${ethers.formatUnits(s.cap, 18)} spent ${ethers.formatUnits(s.redeemed, 18)} RLUSD`; } catch {}
    console.log(c.channel_id, c.channel_status.padEnd(8), state, c.failure ? `(${c.failure})` : '');
  }
}
