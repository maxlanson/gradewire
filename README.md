# Gradewire

**Verified reward grading for RL, paid per grade in RLUSD through Mastercard AP4M on the XRPL EVM sidechain.**

RL post-training runs on rewards: a model writes code, the code is run against tests, the pass rate is the reward. Gradewire is a network where anyone's computer earns money doing that grading. A sample of grades is re-run by independent verifiers; because the grading is deterministic, a re-run either matches exactly or proves the grader cheated. The training agent pays per grade over HTTP 402, and **the next payment to a grader waits for the verdict on its last checked job**. A failed verdict slashes the grader's bond and refunds the buyer in the same transaction.

> "RL runs on rewards. We make every reward checkable, and nobody gets paid for a grade that doesn't hold up."

Built at the AI & Fintech XRPL Hackathon (New York, Oct 24–25 2026). Everything in this repo was written during the event. Main track: **Agentic Finance**.

## What runs live

| Component | Where | What it does |
|---|---|---|
| **Provider node** (`packages/node`) | any laptop with Docker | Registers, passes a benchmark, bonds RLUSD on-chain, sells `GET /grade/{job}` behind **HTTP 402 (AP4M x402)**, runs the job in a locked-down container, signs the canonical result, reports it, streams telemetry. `--cheat` returns "all passed" without running anything. |
| **Trainer agent** (`packages/trainer`) | team laptop | Picks graders by price ÷ reliability score, opens one AP4M Channel per grader, pays per grade with a locally signed Voucher, verifies spec hash + result hash + signature, **gates the next payment on the verdict**, bans and reroutes on a failed verdict, settles. |
| **Coordinator** (`packages/coordinator`) | team server | Registry, benchmark attestation, sampling (100 % for a grader's first 3 checks, then 50 %), opens on-chain verification tasks, watches events, scores, incidents, SSE feed, dashboard, Quicknode Streams webhook, anchors verdicts on the native XRP Ledger. |
| **Verifiers** (`packages/verifier`) ×3 | team server | Allowlisted operators: see `NewTaskCreated`, re-run the job in the identical sandbox, respond on-chain with an EIP-712-signed `(taskId, matched, hash)`. |
| **Contracts** (`contracts/`) | XRPL EVM Testnet | `GradewireRegistry` (bonds, slashing, approver-gated withdrawal) and `GradingServiceManager` (AVS-pattern tasks, 2-of-3 quorum, slash on fail). |
| **Dashboard** (`packages/dashboard`) | `http://127.0.0.1:4500/` | Live graders, scores, payments, verification tasks, verdicts, slashes, refunds, with explorer links. |

Deployed contracts (chain 1449000): see [`deployments/testnet.json`](deployments/testnet.json).

## How a grade gets paid and checked

```
trainer ── POST /jobs ──▶ node                      (unpaid: job accepted, paid URL returned)
trainer ── GET /grade/{job} ─▶ node: 402 + PAYMENT-REQUIRED (price, channel, cumulative amount)
trainer signs Voucher (EIP-712, key never leaves the machine) ── GET again with PAYMENT-SIGNATURE
node redeems the Voucher on the AP4M PaymentLedger ─▶ VoucherRedeemed event
node runs the job in the sandbox, signs result_hash, returns the grade ── reports to coordinator
coordinator samples ─▶ ServiceManager.createVerificationTask(jobId, provider, buyer, hash)
3 verifiers re-run ─▶ respondToTask(signed) ─▶ VerdictPosted at 2-of-3
  pass: trainer pays the grader for its next job
  fail: Registry.slash in the same tx: 50 % refunds the trainer, 30 % to the verifiers, 20 % treasury;
        grader suspended; trainer stops paying it and reroutes its work
coordinator anchors each verdict hash as a memo on the native XRP Ledger (Testnet)
```

### Why a re-run is a proof

The sandbox is pinned by multi-arch image digest, runs with no network, read-only root, a non-root user, dropped capabilities, fixed CPU/memory/pid limits and a fixed environment (`TZ`, `LANG`, `PYTHONHASHSEED`, `SOURCE_DATE_EPOCH`). The runner records only pass/fail per test, never timings. `result_hash = sha256(canonical_json(result))`. The same job gives the same hash on every honest machine; we verified 20 rollouts twice each, and across node restarts, with identical hashes. A timeout is a valid deterministic result.

### Honest framing

- Only a **sample** is re-run. The bond makes cheating unprofitable: with price *p* and sampling rate *s*, expected unearned payout before being caught is *p(1−s)/s*.
- Cheating on a job whose honest answer is "all passed" is undetectable **and harmless**: the grade is correct. The catch happens on the first buggy rollout.
- Decentralized compute, marketplaces and agent payments are not new. Exact verification of deterministic grading, with payment gated on it and settled in dollars on XRPL, is the part that is.
- GPU inference is not bit-reproducible; this design is for CPU grading only.
- Demo bonds are 0.01 RLUSD because the team budget is 20 testnet RLUSD; the contract takes any size.

## Run it

Requirements: Node ≥ 22.13, Docker, Foundry (only to redeploy). One `.env` (never committed) with the AP4M agent and merchant keys from the participant portal, plus the keys `scripts/keys.mjs` generates.

```bash
npm install
node --env-file=.env scripts/keys.mjs              # coordinator, 3 operators, dev approver (+ gas)
# redeploy only if you changed operators/approver:
# (cd contracts && forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.xrplevm.org --broadcast)
node --env-file=.env scripts/fund-nodes.mjs 4401 4402 4403   # gas + 0.01 RLUSD bond per grader
scripts/demo-up.sh                                 # coordinator, 3 verifiers, 2 honest graders, 1 cheater
open http://127.0.0.1:4500/
scripts/trainer.sh --jobs 9                        # the agent pays, verifies, gets a cheater caught
scripts/demo-down.sh
```

The 3-minute stage script is in [`docs/DEMO.md`](docs/DEMO.md). Tier 0 wrappers for the raw AP4M demos are `scripts/demo1.sh` and `scripts/demo2-*.sh`.

## Sponsor integrations

### Mastercard AP4M (every payment)

Payment is the product: no grade is delivered before its Voucher is redeemed. Each node is an x402 merchant built on the kit's primitives (`buildMerchantResourceChallenge`, `prepareX402Redemption`, `verifyMerchantResourceRedemption`), extended from one fixed `/resource` to a **per-job resource URL** with content computed after payment. The trainer uses the kit's `buyResource` unchanged. Vouchers are cumulative per Channel, so the trainer keeps **one Channel per grader** and pays graders in parallel. Settlement releases RLUSD to the team payout wallet; receipts are printed by the trainer.

Things we hit and handled (all retried, never skipped): the public RPC can return `null` for a just-broadcast transaction (the kit's post-redemption check fails once); the AP4M service intermittently answers with an HTML error page; the SDK's canonical JSON rejects decimal numbers (grades carry decimal rewards). Both sides persist state before paying, so a crash on either side never pays twice or loses a paid grade.

### Quicknode

`POST /webhooks/quicknode` on the coordinator ingests a **Streams** payload of raw logs for the three contracts (`VoucherRedeemed`, `NewTaskCreated`, `TaskResponded`, `VerdictPosted`, `Slashed`) and routes it through the same handler as the local watcher, de-duplicated by `(txHash, logIndex)`. Set `QUICKNODE_RPC_URL` and every process uses the Quicknode endpoint instead of the public RPC. Why it matters here: the trainer's payment gating waits on `VerdictPosted`; event latency is money latency. **Status:** the webhook is implemented and the dashboard labels Quicknode-sourced payments; the Stream itself needs a Quicknode account (create a Stream on chain 1449000, dataset "logs", filter by the addresses in `deployments/testnet.json`, destination `https://<tunnel>/webhooks/quicknode`, header `x-gradewire-secret`).

### Ledger

The agent never holds a raw unlimited key: it spends from AP4M Channels with a cap. Bond withdrawals need an **approver signature** checked on-chain (`GradewireRegistry.withdrawBond` recovers an EIP-712 `WithdrawApproval(provider, amount, nonce, deadline)`), so a stolen node key cannot drain a bond. `scripts/approve-withdraw.mjs` prints the exact typed data for a hardware wallet (`eth_signTypedData_v4`); `--dev` signs with a software key so the flow can be exercised without a device. **Status:** contract gate deployed and tested; signing on a physical Ledger was not exercised (no device at the table).

### AWS Bedrock AgentCore

`packages/trainer/agentcore/agentcore_app.py` wraps the trainer as an AgentCore Runtime entrypoint exposing `gradewire.grade_rollouts` as the agent's paid tool. **Status:** scaffold only; not deployed (no AWS credentials at build time).

### Native XRP Ledger

Every verdict is anchored as a memo on a 1-drop XRPL Testnet payment by the coordinator (`packages/coordinator/anchor.mjs`); the dashboard links each to testnet.xrpl.org.

## What was cut

Nomad (direct HTTP dispatch instead), VictoriaMetrics (SQLite telemetry table), WireGuard, real RL training (pre-generated rollouts in `tasks/`), EigenLayer core contracts (standalone AVS-pattern contracts, same events). Never cut: live AP4M payments, the verification re-run, the cheater catch.

## Repo map

```
packages/ap4m         AP4M kit, vendored as-is (+ .cjs copies for ESM)
packages/shared       canonical JSON, hashing, job schema, chain helpers, EIP-712 types
packages/node         provider node: x402 per-job merchant, sandbox runner, join/bond/telemetry
packages/coordinator  registry, sampling, verdict watcher, scores, SSE, webhook, XRPL anchor
packages/verifier     operator process
packages/trainer      buyer agent (+ AgentCore scaffold)
packages/dashboard    one HTML page over SSE
contracts/            Foundry: Registry, ServiceManager, tests, deploy script
sandbox/runner.py     deterministic test runner inside the container
tasks/rollouts.mjs    20 hermetic toy rollouts (10 tasks × good/bad)
scripts/              keys, funding, launch, demo, Ledger-gated withdrawal
docs/DEMO.md          stage script
```

Credit: the reliability-monitoring flowchart that this design grew from is the Quok.it senior-design poster (Penn, Team 20).
