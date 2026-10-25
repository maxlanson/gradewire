# Quicknode runbook: RPC endpoint + Streams webhook

Goal: every Gradewire process reads XRPL EVM Testnet through a Quicknode endpoint, and a Quicknode
**Stream** pushes the logs of our three contracts to the coordinator's `POST /webhooks/quicknode`,
so verdicts (which gate the agent's next payment) reach the coordinator by push instead of its own
4-second polling loop. Budget: about 15 minutes once you have a Quicknode account.

Why it matters (the sentence for the README): *the ask agent pays a node for its next job only
after the previous job's `VerdictPosted` has landed, so event latency is money latency; the
Quicknode Stream delivers `VoucherRedeemed`, `NewTaskCreated`, `TaskResponded`, `VerdictPosted`
and `Slashed` to the coordinator the moment they are mined and replaces its polling watcher.*

Contract addresses the Stream must watch (all on chain 1449000):

| Contract | Address | Source |
|---|---|---|
| AP4M PaymentLedger (`VoucherRedeemed`) | `0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91` | `https://hackathon.ap4m.build/public/config` → `contracts.paymentLedger` (checked live) |
| GradewireRegistry (`Bonded`, `Slashed`, `BondWithdrawn`, `ProviderRegistered`, `ProviderAttested`) | `0x8362da758e5bf63bc21f2e7bb0ec49c89879b7c3` | `deployments/testnet.json` → `registry` |
| GradingServiceManager (`NewTaskCreated`, `TaskResponded`, `VerdictPosted`) | `0xa85ab97518c6d118a521e8c2d7df561e5a2bb62f` | `deployments/testnet.json` → `serviceManager` |

(RLUSD `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3` is not watched: the coordinator only
needs the events above.)

## (a) Join the Quicknode track

In the hackathon app (hackathons.xrpl-commons.org), open the project → Prizes/Tracks → **Quicknode**
→ Join. Without this the project is not eligible for the Quicknode prize, whatever the code does.
Tick the box in `docs/SUBMISSION.md`.

## (b) RPC endpoint

1. Quicknode console → **Endpoints** → **Create endpoint** → chain **XRPL EVM**, network
   **Testnet** (Quicknode lists XRPL EVM Mainnet and Testnet; the Streams support table confirms
   the same networks).
2. Copy the HTTPS URL (it looks like `https://<name>.xrpl-evm-testnet.quiknode.pro/<token>/`;
   copy it from the console rather than trusting that pattern).
3. Put it in `.env` (never committed):

   ```
   QUICKNODE_RPC_URL=https://<name>.xrpl-evm-testnet.quiknode.pro/<token>/
   ```

   `packages/shared/chain.mjs` → `rpcUrl()` prefers `QUICKNODE_RPC_URL` over `AP4M_RPC_URL` and
   the public `rpcUrl` in `deployments/testnet.json`, so the coordinator, the three verifiers,
   the nodes, the ask agent and the trainer all switch on the next restart (`scripts/demo-down.sh`
   then `scripts/demo-up.sh`). Check with any process's startup line or with
   `node --env-file=.env scripts/test-quicknode-webhook.mjs --dry-run`, whose first line prints
   the RPC it used.

## (c) Expose the coordinator

The coordinator listens on `127.0.0.1:4500`, so Quicknode needs a public HTTPS URL for it:

```bash
scripts/tunnel.sh            # cloudflared quick tunnel (installed) or ngrok; prints the URL
```

It prints `https://<random>.trycloudflare.com` and saves it to `.state/tunnel-4500.url`. The URL
changes every time the tunnel restarts, so keep this terminal open for the whole demo and edit the
Stream's destination if you ever restart it. Then pick a secret and add it to `.env`:

```
QUICKNODE_WEBHOOK_SECRET=<any long random string>
```

and restart the coordinator so it requires the `x-gradewire-secret` header (when the variable is
unset the coordinator accepts unauthenticated posts).

## (d) Create the Stream

Quicknode console → **Streams** → **+ New Stream**. Settings for this project:

| Screen | Setting | Value |
|---|---|---|
| Configure | Name | `gradewire-events` |
| | Chain / Network | **XRPL EVM / Testnet**. Quicknode's Streams "Supported Chains" table lists XRPL EVM Mainnet and Testnet with Block, Block with Receipts, Transactions, Logs and Receipts (no trace datasets). If the console does not offer XRPL EVM Testnet on your plan, the fallback is to skip the Stream and keep the coordinator's own RPC watcher (it already runs through the Quicknode RPC endpoint from step b); say so in the submission. |
| | Start | Latest block (the coordinator's own watcher has already seen history; a backfill would only produce de-duplicated no-ops) |
| | Batch size | 1 (lowest latency) |
| | Reorg handling / keep distance from tip | 0 or the minimum offered; the coordinator de-duplicates by `(txHash, logIndex)` so a re-stream is harmless |
| Dataset | Dataset | **Logs** (`logs`). If Logs is greyed out use **Block with Receipts**; the filter below handles both. Optionally click **Fetch payload** to see a live sample. |
| Filter | "Customize your payload" | paste the function below, then **Test** it (returns `null` for blocks without our events, which is normal) |
| Destination | Type | Webhook |
| | URL | `https://<tunnel>/webhooks/quicknode` (from step c) |
| | Compression | None (the coordinator reads plain JSON; do not pick gzip) |
| | Custom headers | `x-gradewire-secret` = the value of `QUICKNODE_WEBHOOK_SECRET` in `.env` |
| | Timeout / retries | defaults (30 s, 3 retries 1 s apart; after 3 failures the Stream pauses itself, resume it from the dashboard) |
| | Check Connection | reachability only; it does not send a sample payload. Add the header before clicking it, otherwise the coordinator answers 401 once the secret is configured. |
| | Create a Stream | the Stream goes live immediately |

Filter function (JavaScript; the console requires the function to be named `main`, with no
`require`/`import`/network access). It keeps only logs from the three contracts and returns them as
one **flat array of raw log objects**, which is exactly what the coordinator parses:

```js
function main(stream) {
  const WATCH = new Set([
    '0xcab42800a5ecf0d253fa2581bb3334b4daefae91', // AP4M PaymentLedger   (VoucherRedeemed)
    '0x8362da758e5bf63bc21f2e7bb0ec49c89879b7c3', // GradewireRegistry    (Bonded, Slashed, BondWithdrawn, ...)
    '0xa85ab97518c6d118a521e8c2d7df561e5a2bb62f', // GradingServiceManager (NewTaskCreated, TaskResponded, VerdictPosted)
  ]);
  const out = [];
  // `logs` delivers data as nested arrays of log objects; `receipts` / `block_with_receipts`
  // deliver per-block entries with receipts[].logs[]. Walk whatever arrives.
  const walk = (x) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.address === 'string' && Array.isArray(x.topics)) {
      if (WATCH.has(x.address.toLowerCase())) out.push(x);
      return;
    }
    if (Array.isArray(x.receipts)) { for (const r of x.receipts) walk(r.logs || []); return; }
    if (Array.isArray(x.logs)) walk(x.logs);
  };
  walk(stream.data);
  return out.length ? out : null; // null = nothing delivered for this block
}
```

Each delivered log object carries `address, topics[], data, blockNumber, transactionHash,
transactionIndex, blockHash, logIndex, removed`, with the numbers as hex strings (`"0x8ccc4f"`).

### Does Quicknode's payload match the coordinator's parser?

What the coordinator does (`packages/coordinator/index.mjs`, route `POST /webhooks/quicknode`):

1. Rejects with 401 unless `x-gradewire-secret` equals `QUICKNODE_WEBHOOK_SECRET` (only when set).
2. Unwraps the body: a bare array is used as-is; otherwise `body.data` if it is an array; otherwise
   nothing. Then `.flat()` (**one level**).
3. Keeps entries that have `topics` and `address`, and calls `handleLog` with
   `address, topics, data ?? '0x', transactionHash, index = Number(logIndex ?? index ?? 0),
   blockNumber = Number(blockNumber)`; hex strings convert correctly (`Number('0x2') === 2`).
4. `handleLog` de-duplicates on `transactionHash:index` in the `seen_logs` table, so a log already
   seen by the RPC watcher (or sent twice by the Stream, or by the test script below) is a no-op.
5. Answers `200 {"handled": n}` where `n` counts entries passed to `handleLog`, including
   duplicates.

With the filter above the body is a flat array of logs (or, if Quicknode wraps filtered output in
its `{data, metadata}` envelope, `data` is that flat array): **both shapes parse with the current
code, no coordinator change needed.** Quicknode's own docs are ambiguous on whether a filter's
return value is delivered bare or wrapped ("that value is delivered" vs. the `{data, metadata}`
envelope on the data-sources page), which is why the filter returns a bare array: it parses either
way.

Two adaptations for the coordinator agent (not applied here):

- **Unfiltered `logs` dataset.** Quicknode documents `data` for the `logs` dataset as an array of
  arrays of log objects, and its example nests three levels (`data[0][0][0]` is a log). The
  coordinator's `.flat()` only removes one level, so an unfiltered Stream (or a Stream whose filter
  returns the nested shape) is accepted with `{"handled":0}` and silently ignored. Changing
  `logs.flat()` to `logs.flat(Infinity)` in the webhook route makes every documented shape work.
  `scripts/test-quicknode-webhook.mjs --shape raw` reproduces this case.
- **Visibility.** The route prints no log line on receipt: the only traces are the HTTP reply, the
  `seen_logs.source = 'quicknode'` rows, and the dashboard's "via Quicknode Stream" suffix, which
  only payment events carry (`emit('payment', {..., source})`); task/verdict/slash emits do not
  pass `source`. **Done:** the route logs `[quicknode] webhook delivery: N new, M already seen`
  and each fresh log as `[quicknode] log <tx>:<index> from the Stream`, task/verdict/slash events
  carry `source`, and nested payloads are unwrapped with `flat(Infinity)`. The RPC watcher polls
  every 4 s and would usually record a log first, making the Stream's delivery a de-duplicated
  no-op; start the coordinator with `WATCH_CHAIN=0` on stage so the Stream is the only event
  source (the coordinator prints that it did).

Optional hardening: Quicknode also signs every delivery with the Stream's security token
(`X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature` = hex HMAC-SHA256 over `nonce + timestamp +
body`) and sends batch metadata as `Stream-*`/`Batch-*` headers; the shared-secret header is enough
for the demo.

### Offline self-test (no Quicknode account needed)

```bash
node --env-file=.env scripts/test-quicknode-webhook.mjs --dry-run          # fetch a real VerdictPosted log, print the payload
node --env-file=.env scripts/test-quicknode-webhook.mjs                    # POST it to http://127.0.0.1:4500/webhooks/quicknode
node --env-file=.env scripts/test-quicknode-webhook.mjs --event VoucherRedeemed --url https://<tunnel>/webhooks/quicknode
node --env-file=.env scripts/test-quicknode-webhook.mjs --shape raw        # the unfiltered-dataset shape (expect handled 0 until .flat(Infinity))
```

It reads the most recent matching log from the chain (last 5000 blocks, falling back to the README
proof transactions), wraps it exactly like the Stream does, sends it with the secret header and
prints the HTTP status and body. Safe to repeat: the coordinator de-duplicates. Posting through the
tunnel URL proves the whole path (tunnel → coordinator → secret check) before the Stream exists.

## (e) Verify it is live

1. Quicknode console → the Stream → deliveries: each delivery should show HTTP 200 and a body
   `{"handled":N}`; a 401 means the header value and `QUICKNODE_WEBHOOK_SECRET` differ, a 404 or
   timeout means the tunnel is down or the URL path is wrong.
2. Trigger an event: `scripts/ask.sh "What is the 1000th prime?" --parts 1` (pays one node;
   `VoucherRedeemed`, then `NewTaskCreated`/`TaskResponded`/`VerdictPosted` if sampled).
3. Coordinator: the webhook currently logs nothing by itself (see above); check
   `sqlite3 .state/coordinator/coordinator.sqlite "select source, count(*) from seen_logs group by source"`
   for `quicknode` rows, or the `[quicknode]` log lines once the coordinator agent adds them.
4. Dashboard (`http://127.0.0.1:4500/`): a payment line in the feed ends with
   **"via Quicknode Stream"** when the Stream delivered it before the RPC watcher did.

## (f) README

Replace the Quicknode "Status" paragraph with: *Stream `gradewire-events` on XRPL EVM Testnet,
dataset Logs, filtered to the PaymentLedger, Registry and ServiceManager addresses, destination
`https://<tunnel>/webhooks/quicknode` with the `x-gradewire-secret` header; every process reads
the chain through `QUICKNODE_RPC_URL`.* Why Quicknode is essential rather than decorative: the
agent's next payment to a node waits on that node's `VerdictPosted`; the Stream turns a 4-second
polling loop into a push, and the same feed drives the dashboard and the reliability scores.

## REST alternative (optional)

The Streams REST API (`POST https://api.quicknode.com/streams/rest/v1/streams`, header
`x-api-key`) takes `name, network, dataset, region ("usa_east"), dataset_batch_size,
elastic_batch_enabled, destination ("webhook"), destination_attributes {url, compression ("none"),
headers {"x-gradewire-secret": "..."}, max_retry, retry_interval_sec, post_timeout_sec}, status
("active"), filter_function` (base64 of the function above), `start_range`,
`keep_distance_from_tip`. The `network` slug for XRPL EVM Testnet is not printed in the docs
(the examples use `ethereum-mainnet`); read it from the console's Stream settings or the Supported
Chains page before scripting it. The console path above is faster for one Stream.

## Not verified here

No Quicknode account was available while writing this, so nothing above was exercised against the
service: the console labels, the exact delivered envelope for filtered output and the XRPL EVM
Testnet availability on the team's plan come from Quicknode's documentation
(`quicknode.com/docs/streams/...`: supported-chains, filters, filters/examples,
destinations/webhooks, data-sources, data-sources/ethereum-evm, rest-api) as of Oct 24 2026.
