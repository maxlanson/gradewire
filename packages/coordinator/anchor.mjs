// Anchors each verdict on the native XRP Ledger (Testnet): an AccountSet transaction whose memo
// carries the verdict hash, so the EVM-side verdict is also attested on the main ledger.
// The coordinator's XRPL wallet is created and faucet-funded on first use.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client, Wallet, convertStringToHex } from 'xrpl';

const XRPL_WS = process.env.XRPL_TESTNET_WS || 'wss://s.altnet.rippletest.net:51233';
export const XRPL_EXPLORER = 'https://testnet.xrpl.org';

export function createAnchor(stateDir) {
  const file = join(stateDir, 'xrpl-wallet.json');
  let client;
  let wallet;
  let ready;

  async function init() {
    client = new Client(XRPL_WS);
    await client.connect();
    if (existsSync(file)) {
      wallet = Wallet.fromSeed(JSON.parse(readFileSync(file, 'utf8')).seed);
    } else {
      ({ wallet } = await client.fundWallet());
      writeFileSync(file, JSON.stringify({ seed: wallet.seed, address: wallet.classicAddress }), { mode: 0o600 });
    }
    console.log(`[anchor] XRPL Testnet wallet ${wallet.classicAddress}`);
  }

  // Returns { hash, url } or throws. Serialized: one anchor at a time keeps sequence numbers simple.
  let queue = Promise.resolve();
  function anchor(kind, payload) {
    const run = async () => {
      if (!ready) ready = init();
      await ready;
      const memo = JSON.stringify({ app: 'gradewire', kind, ...payload });
      // AccountSet with no flag changes is a valid, fee-only transaction that carries memos
      // (a self-payment is rejected by the ledger as temREDUNDANT).
      const tx = await client.autofill({
        TransactionType: 'AccountSet', Account: wallet.classicAddress,
        Memos: [{ Memo: { MemoType: convertStringToHex('gradewire/verdict'), MemoData: convertStringToHex(memo), MemoFormat: convertStringToHex('application/json') } }],
      });
      const result = await client.submitAndWait(wallet.sign(tx).tx_blob);
      const code = result.result.meta?.TransactionResult;
      if (code !== 'tesSUCCESS') throw new Error(`XRPL anchor failed: ${code}`);
      return { hash: result.result.hash, url: `${XRPL_EXPLORER}/transactions/${result.result.hash}` };
    };
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  }

  return { anchor, address: () => wallet?.classicAddress, close: () => client?.disconnect() };
}
