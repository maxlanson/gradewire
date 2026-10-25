// Per-job x402 handling for a provider node, adapted from the kit's createX402Merchant
// (packages/ap4m/ap4m-x402.mjs). The kit sells one fixed resource at /resource; a grader
// sells a different result for every job, so this version resolves the resource from the
// request URL and computes the content once the Voucher is redeemed on-chain. The safety
// logic (persist before submit, reconcile on retry, never redeem twice) is kept as-is.

import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  buildMerchantResourceChallenge, buildX402Challenge, buildX402RedemptionResponse, canonicalJson, derivePaymentClaimId,
  encodeX402PaymentRequired, encodeX402PaymentResponse, encodeX402PaymentSignature, decodeX402PaymentSignature, hashPaymentVoucher,
  PARTICIPANT_LEDGER_INTERFACE, parseX402ResourceUrl, prepareX402Redemption, readPublicLogs,
  verifyMerchantResourceRedemption, verifyX402Payment,
} from '@ap4m/sdk';
import { readParticipantFinalizedBlock, readParticipantPaymentChannel, readPaymentChannelBinding } from '@ap4m/sdk/participant-requests';

import { canonicalJson as resourceJson } from '../shared/index.mjs';

/**
 * @param {{
 *   context, provider, submitter, stateDirectory, merchantParticipantId, payout,
 *   resolve: (url: string) => { amount: string, produce: () => Promise<Record<string, unknown>> } | undefined,
 *   cutoffMarginSeconds?: number,
 * }} config
 * resolve() maps a full resource URL to its price (wei) and a function that computes the
 * content after payment. Returns undefined for unknown URLs.
 */
export function createX402Resources(config) {
  const cutoffMarginSeconds = config.cutoffMarginSeconds ?? 5;
  const clock = () => Math.floor(Date.now() / 1000);
  const now = (blockTimestamp) => Math.max(blockTimestamp, clock());
  const { context, provider } = config;
  const paymentContext = context.x402;

  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  if (!lstatSync(config.stateDirectory).isDirectory() || lstatSync(config.stateDirectory).isSymbolicLink()) {
    throw new Error('state directory must be a real directory');
  }
  chmodSync(config.stateDirectory, 0o700);
  const lockPath = join(config.stateDirectory, 'merchant.lock');
  // The lock holds the owner's pid. A lock whose owner is gone (a node that crashed or was killed
  // without closing) is stale and is reclaimed; a lock owned by a live process is a hard error.
  const takeLock = () => { const fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, String(process.pid)); return fd; };
  let lock;
  try {
    lock = takeLock();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(lockPath, 'utf8').trim());
    let alive = false;
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid) {
      try { process.kill(owner, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    }
    if (alive) {
      throw new Error(`${lockPath} is held by running node pid ${owner}: another node is using this state directory.`);
    }
    console.log(`[x402] reclaiming stale ${lockPath} (owner ${owner || 'unknown'} is gone)`);
    unlinkSync(lockPath);
    lock = takeLock();
  }
  const dbPath = join(config.stateDirectory, 'merchant.sqlite');
  let db;
  try {
    try { closeSync(openSync(dbPath, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    chmodSync(dbPath, 0o600);
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS challenges (channel_id TEXT NOT NULL, url TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (channel_id, url)) STRICT;
      CREATE TABLE IF NOT EXISTS payments (
        voucher_digest TEXT PRIMARY KEY, channel_id TEXT NOT NULL, url TEXT NOT NULL, value TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS resource_results (voucher_digest TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS pending_channel ON payments(channel_id) WHERE complete=0;`);
    // This process is starting, so the previous one died mid-flight. A payment it retained can only be
    // finished by the buyer replaying that exact Voucher, and a buyer whose node vanished has long
    // since rerouted the job and set the Voucher aside; left in place the retained payment would
    // refuse every new purchase on its Channel for good. Void them all. If one had already been
    // redeemed on-chain, the node was paid for a result it never delivered: that is logged, and it is
    // the node's reliability score, not the buyer, that pays for it.
    db.prepare("DELETE FROM payments WHERE complete=1 AND json_extract(value, '$.transactionHash') IS NULL AND voucher_digest NOT IN (SELECT voucher_digest FROM resource_results)").run(); // rows voided by an earlier version
    const left = db.prepare("SELECT channel_id, json_extract(value, '$.transactionHash') AS tx FROM payments WHERE complete=0").all();
    if (left.length) {
      // Delete, do not mark complete: the next Voucher on that Channel has the same running total and
      // therefore the same digest, and a leftover row with that digest would be a 'payment conflict' forever.
      db.prepare('DELETE FROM payments WHERE complete=0').run();
      for (const r of left) console.log(`[x402] voided a payment left unfinished by the previous run on channel ${String(r.channel_id).slice(0, 10)}… (${r.tx ? `redeemed in ${String(r.tx).slice(0, 12)}…, result never delivered` : 'never submitted'}); the Channel is usable again`);
    }
  } catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }

  let queue = Promise.resolve();
  let queued = 0;
  let closing = false;

  // Returns true when the request was an x402 resource request (handled), false otherwise.
  function serve(incoming, response, resourceUrl) {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Vary', 'PAYMENT-SIGNATURE, X-AP4M-CHANNEL-ID');
    if (closing || queued >= 32) return send(response, 503, { error: 'merchant_busy' });
    if (!config.resolve(resourceUrl)) return send(response, 404, { error: 'unknown_resource' }); // never queue junk URLs
    queued++;
    const work = queue.then(() => handle(incoming, response, resourceUrl)).catch((error) => {
      console.error(`[x402] ${resourceUrl}: ${error.message}`);
      send(response, 503, { error: 'payment_pending_or_unavailable', retrySamePayment: true });
    }).finally(() => { queued--; });
    queue = work;
  }

  async function handle(incoming, response, resourceUrl) {
    parseX402ResourceUrl(resourceUrl);
    const resource = config.resolve(resourceUrl);
    if (!resource) return send(response, 404, { error: 'unknown_resource' });
    if (!/^[1-9][0-9]*$/.test(resource.amount)) throw new Error('price must be a positive integer in token base units');
    const channelId = header(incoming, 'x-ap4m-channel-id');
    if (!channelId || !/^0x(?!0{64}$)[0-9a-f]{64}$/.test(channelId)) return send(response, 400, { error: 'invalid_channel_id' });
    const paymentHeader = header(incoming, 'payment-signature');
    if (!paymentHeader) {
      const binding = await readPaymentChannelBinding(provider, context.participantRequest, channelId);
      const channel = binding.channel;
      if (!channel || binding.lifecycle !== 'ChannelOpen' || binding.payout?.channelId !== channelId) throw new Error('Channel is not a managed open binding');
      if (channel.merchantId.toLowerCase() !== config.merchantParticipantId.toLowerCase() || channel.payout.toLowerCase() !== config.payout.toLowerCase()) return send(response, 403, { error: 'channel_for_another_merchant' });
      const latest = await provider.getBlock(await provider.getBlockNumber());
      const current = latest ? now(latest.timestamp) : undefined;
      if (current === undefined || current >= channel.validBefore - cutoffMarginSeconds) return send(response, 409, { error: 'merchant_acceptance_closed' });
      // A payment retained before a crash whose challenge window has closed can never be redeemed
      // (the Voucher is only valid inside that window) and was never submitted on-chain, so it must
      // not block this Channel for every later purchase: void it. (A retained payment that was
      // submitted keeps its transactionHash and is reconciled through chain events below.)
      // A retained payment the buyer has not replayed within about two minutes of its challenge
      // (validBefore is issue time + 300 s) was abandoned by a buyer that rerouted the job: void it
      // rather than refuse this Channel until the window closes.
      const voided = db.prepare("DELETE FROM payments WHERE channel_id=? AND complete=0 AND json_extract(value, '$.challenge.value.validBefore') < ?").run(channelId, current + 180);
      if (voided.changes) console.log(`[x402] voided ${voided.changes} abandoned payment(s) on channel ${channelId.slice(0, 10)}… (not replayed for 2 min); the Channel is usable again`);
      if (db.prepare('SELECT 1 FROM payments WHERE channel_id=? AND complete=0').get(channelId)) return send(response, 409, { error: 'retry_retained_payment' });
      const existing = db.prepare('SELECT value FROM challenges WHERE channel_id=? AND url=?').get(channelId, resourceUrl);
      let challenge = existing ? JSON.parse(String(existing.value)) : undefined;
      if (!challenge || challenge.value.previousCumulativeAmount !== channel.redeemed || challenge.value.amount !== resource.amount
        || current >= challenge.value.validBefore - cutoffMarginSeconds) {
        const validBefore = Math.min(channel.validBefore, paymentContext.validBefore, binding.chainTimestamp + 300);
        if (current >= validBefore - cutoffMarginSeconds) {
          response.setHeader('Retry-After', '15');
          return send(response, 503, { error: 'chain_head_stale', retryAfterSeconds: 15 });
        }
        if (!existing && Number(db.prepare('SELECT count(*) AS n FROM challenges').get().n) >= 4096) return send(response, 503, { error: 'merchant_capacity_reached' });
        challenge = await buildMerchantResourceChallenge(provider, paymentContext.merchant, {
          channelId, merchantParticipantId: config.merchantParticipantId, payout: config.payout, amount: resource.amount,
          resource: { uri: resourceUrl, description: 'Gradewire verified grade', mimeType: 'application/json' },
          validBefore,
        });
        db.prepare('INSERT INTO challenges VALUES (?,?,?) ON CONFLICT(channel_id, url) DO UPDATE SET value=excluded.value').run(channelId, resourceUrl, canonicalJson(challenge));
      }
      response.setHeader('PAYMENT-REQUIRED', encodeX402PaymentRequired(buildX402Challenge(paymentContext, challenge.value, challenge.digest)));
      return send(response, 402, { x402Version: 2, error: 'payment_required' });
    }
    let normalized;
    try { normalized = encodeX402PaymentSignature(decodeX402PaymentSignature(paymentHeader)); } catch { return send(response, 400, { error: 'invalid_payment' }); }
    const payload = decodeX402PaymentSignature(normalized);
    if (payload.accepted.extra.channelId !== channelId) return send(response, 400, { error: 'wrong_channel' });
    if (payload.accepted.extra.pricingMode !== 'fixed' || !('cumulativeAmount' in payload.payload.voucher)) return send(response, 400, { error: 'fixed_pricing_required' });
    const requestedDigest = hashPaymentVoucher(paymentContext.merchant, {
      channelId: payload.payload.voucher.channelId, cumulativeAmount: BigInt(payload.payload.voucher.cumulativeAmount),
    });
    const row = db.prepare('SELECT voucher_digest,value,complete FROM payments WHERE voucher_digest=? AND url=?').get(requestedDigest, resourceUrl);
    let retained;
    let replay = false;
    let voucherDigest;
    if (row && JSON.parse(String(row.value)).header === normalized) {
      retained = JSON.parse(String(row.value));
      voucherDigest = row.voucher_digest;
      replay = true;
    } else {
      const issued = db.prepare('SELECT value FROM challenges WHERE channel_id=? AND url=?').get(channelId, resourceUrl);
      if (!issued) return send(response, 409, { error: 'request_challenge_first' });
      const challenge = JSON.parse(String(issued.value));
      const head = await provider.getBlock(await provider.getBlockNumber());
      if (!head || now(head.timestamp) >= challenge.value.validBefore - cutoffMarginSeconds) return send(response, 409, { error: 'merchant_acceptance_closed' });
      let plan;
      try { plan = await prepareX402Redemption(provider, paymentContext, challenge.value, challenge.digest, normalized); } catch { return send(response, 400, { error: 'invalid_payment' }); }
      voucherDigest = plan.payment.voucherDigest;
      if (db.prepare('SELECT 1 FROM payments WHERE voucher_digest=? OR (channel_id=? AND complete=0)').get(voucherDigest, channelId)) return send(response, 409, { error: 'payment_conflict' });
      retained = { challenge, header: normalized, transactionHash: null };
      db.prepare('INSERT INTO payments(voucher_digest,channel_id,url,value) VALUES (?,?,?,?)').run(voucherDigest, channelId, resourceUrl, canonicalJson(retained));
      try {
        retained.transactionHash = (await config.submitter.sendTransaction({ to: plan.transaction.to, data: plan.transaction.data, value: 0n })).hash;
        db.prepare('UPDATE payments SET value=? WHERE voucher_digest=?').run(canonicalJson(retained), voucherDigest);
      } catch { /* Reconcile a lost submission response through canonical events below. */ }
    }
    const payment = verifyX402Payment(paymentContext, retained.challenge.value, retained.challenge.digest, retained.header);
    let transactionHash = retained.transactionHash;
    if (replay || !transactionHash) {
      const claimId = derivePaymentClaimId(paymentContext.merchant, {
        channelId: payment.voucher.channelId, cumulativeAmount: BigInt(payment.voucher.cumulativeAmount),
      }, retained.challenge.value.previousCumulativeAmount);
      const safe = await readParticipantFinalizedBlock(provider, context.participantRequest);
      const event = PARTICIPANT_LEDGER_INTERFACE.getEvent('VoucherRedeemed');
      const logs = await readPublicLogs(provider, {
        address: paymentContext.merchant.ledger, topics: [event.topicHash, channelId, claimId],
        fromBlock: retained.challenge.value.finalityBlockNumber, toBlock: safe.number,
      });
      if (logs.length === 1) {
        transactionHash = logs[0].transactionHash;
      } else if (!retained.transactionHash) {
        // The earlier submission never left this process (nonce clash, RPC hiccup) and no
        // redemption exists at the finalized block, so submitting now cannot double-pay.
        const head = await provider.getBlock(await provider.getBlockNumber());
        if (!head || now(head.timestamp) >= retained.challenge.value.validBefore - cutoffMarginSeconds) return send(response, 409, { error: 'merchant_acceptance_closed' });
        const plan = await prepareX402Redemption(provider, paymentContext, retained.challenge.value, retained.challenge.digest, retained.header);
        transactionHash = (await config.submitter.sendTransaction({ to: plan.transaction.to, data: plan.transaction.data, value: 0n })).hash;
        retained.transactionHash = transactionHash;
        db.prepare('UPDATE payments SET value=? WHERE voucher_digest=?').run(canonicalJson(retained), voucherDigest);
        console.log(`[x402] resubmitted redemption for ${resourceUrl}: ${transactionHash}`);
      } else {
        throw new Error('redemption outcome is not confirmed');
      }
    }
    const channelNow = await readParticipantPaymentChannel(provider, context.participantRequest, channelId, await provider.getBlockNumber());
    // The SDK fetches the transaction while waiting for its receipt; a load-balanced RPC can
    // return null for a just-broadcast transaction. The payment row is already persisted, so
    // re-verifying is safe; give the chain a few seconds before handing the Agent a 503.
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await verifyMerchantResourceRedemption(provider, paymentContext.merchant,
          retained.challenge.value, retained.challenge.digest, payment, transactionHash, { acceptLateInclusion: true });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        console.log(`[x402] verification attempt ${attempt} for ${transactionHash.slice(0, 12)}: ${error.message}; retrying`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (retained.transactionHash !== transactionHash) {
      retained.transactionHash = transactionHash;
      db.prepare('UPDATE payments SET value=? WHERE voucher_digest=?').run(canonicalJson(retained), voucherDigest);
    }
    // Payment is confirmed on-chain: now do the work, exactly once per Voucher.
    const existingResource = db.prepare('SELECT content FROM resource_results WHERE voucher_digest=?').get(voucherDigest);
    let resourceContent;
    if (existingResource) {
      resourceContent = String(existingResource.content);
    } else {
      // Our canonical JSON, not the SDK's: grades carry decimal rewards, which the SDK rejects.
      resourceContent = resourceJson(await resource.produce({ transactionHash, channelId, agent: channelNow.agent }));
      if (Buffer.byteLength(resourceContent) > 65_536) throw new Error('resource exceeds 64 KiB');
      db.prepare('INSERT INTO resource_results VALUES (?,?)').run(voucherDigest, resourceContent);
    }
    db.prepare('UPDATE payments SET complete=1 WHERE voucher_digest=?').run(voucherDigest);
    response.setHeader('PAYMENT-RESPONSE', encodeX402PaymentResponse(buildX402RedemptionResponse(result, context.network)));
    if (replay) response.setHeader('Idempotency-Replayed', 'true');
    send(response, 200, { resource: JSON.parse(resourceContent), redemption: result });
  }

  return {
    serve,
    async close() {
      if (closing) return;
      closing = true;
      await queue;
      db.close(); closeSync(lock); unlinkSync(lockPath);
    },
  };
}

function header(incoming, name) {
  if (incoming.rawHeaders.filter((_, i) => i % 2 === 0 && incoming.rawHeaders[i].toLowerCase() === name).length > 1) throw new Error('duplicate header');
  const value = incoming.headers[name];
  if (value !== undefined && typeof value !== 'string') throw new Error('invalid header');
  return value;
}

export function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) });
  response.end(encoded);
}
