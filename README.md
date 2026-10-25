# Gradewire

**Verified pay-per-job compute for AI agents, paid in RLUSD through Mastercard AP4M on the XRPL EVM sidechain.**

Gradewire is a network where anyone's computer sells compute to AI agents, one job at a time. An agent on your own laptop takes your question, writes small deterministic Python programs and farms them out to untrusted nodes that run them in a locked-down sandbox and sell each run over HTTP 402 through Mastercard AP4M. A coordinator samples the jobs and three independent verifiers re-run them, posting a 2-of-3 verdict on-chain; because the sandbox is deterministic, a re-run either matches the result hash exactly or proves the node cheated. A failed verdict slashes the node's bond and refunds the agent in the same transaction, the agent stops paying that node and reroutes the work, and it answers only from outputs whose verdicts have come back. **The agent never pays for a result that hasn't held up; verification decides whether money moves at all.** The same network grades reinforcement-learning rollouts as its second, batch workload.

> "Any computer can sell compute to an agent, and the agent never pays for a result that hasn't held up. Verification decides whether money moves at all."

Built at the AI & Fintech XRPL Hackathon (New York, Oct 24–25 2026). Everything in this repo was written during the event. Main track: **Agentic Finance**.

## Teammates: run a node from your laptop

Needs a Mac with Docker Desktop running, plus `brew install node cloudflared`. Then:

```bash
git clone https://github.com/maxlanson/gradewire && cd gradewire
scripts/join.sh --coordinator https://<url from the team laptop> --label "Node <your name>"
```

Send the address it prints to the team laptop to be funded; a minute later your node is on the dashboard and gets paid per job. Details and troubleshooting: [`docs/JOIN.md`](docs/JOIN.md).

## What runs live

| Component | Where | What it does |
|---|---|---|
| **Ask agent** (`packages/ask`) | your laptop | Takes a question, calls Claude to split it into small deterministic Python programs, sends each as a `python-script` job to a different node in parallel, pays per job through the shared client in `packages/trainer/engine.mjs`, **waits until every job's verdict is pass or not-sampled**, bans and reroutes on a failed verdict, then composes the answer only from verified outputs. |
| **Node** (`packages/node`) | any laptop with Docker | Registers, passes a benchmark, bonds RLUSD on-chain, accepts jobs at `POST /jobs` and sells `GET /grade/{job_id}` behind **HTTP 402 (AP4M x402)**, runs the job in a locked-down container, signs the canonical result, reports it, streams telemetry. `--cheat` returns a fabricated output without running anything. |
| **RL trainer** (`packages/trainer`) | team laptop | The second workload: sends `python-fn-tests` jobs (a model's code against unit tests, pass fraction as the reward) through the same engine, same payments, same gating and rerouting. |
| **Coordinator** (`packages/coordinator`) | team laptop, `127.0.0.1:4500` | Registry, benchmark attestation, trust per node (one job at a time and every result re-run for a new node; one more job in flight per clean check up to 3; 50 % sampling after 3 clean checks), opens on-chain verification tasks, watches events, scores, incidents, SSE feed, dashboard, Quicknode Streams webhook, anchors verdicts on the native XRP Ledger. |
| **Verifiers** (`packages/verifier`) ×3 | team laptop | Allowlisted operators: see `NewTaskCreated`, re-run the job in the identical sandbox, respond on-chain with an EIP-712-signed `(taskId, matched, operatorHash)`. |
| **Contracts** (`contracts/`) | XRPL EVM Testnet | `GradewireRegistry` (bonds, slashing, approver-gated withdrawal) and `GradingServiceManager` (AVS-pattern tasks, 2-of-3 quorum, slash on fail). |
| **Dashboard** (`packages/dashboard`) | `http://127.0.0.1:4500/` | Live nodes, scores, payments, verification tasks, verdicts, slashes, refunds, with explorer links. |

Two job kinds share one sandbox and one result format: `python-script` (files: `main.py`; stdout captured up to 16 KiB; result `{job_id, spec_hash, status, exit_code, output, truncated, reward}`, reward 1 for a clean exit) and `python-fn-tests` (a solution plus `test_*.py`; per-test pass/fail; reward = fraction passed).

Deployed contracts (chain 1449000): see [`deployments/testnet.json`](deployments/testnet.json).

## How a job gets paid and checked

```
agent ── POST /jobs ──▶ node                        (unpaid: job accepted, paid URL returned)
agent ── GET /grade/{job_id} ─▶ node: 402 + PAYMENT-REQUIRED (price, channel, cumulative amount)
agent signs Voucher (EIP-712, key never leaves the machine) ── GET again with PAYMENT-SIGNATURE
node redeems the Voucher on the AP4M PaymentLedger ─▶ VoucherRedeemed event
node runs the job in the sandbox, signs result_hash, returns the result ── reports to coordinator
coordinator samples ─▶ ServiceManager.createVerificationTask(jobId, provider, buyer, hash)
3 verifiers re-run ─▶ respondToTask(signed) ─▶ VerdictPosted at 2-of-3
  pass: the agent uses the output; the node has earned one more job in flight (1 for a new node, max 3; 50 % sampling after 3 clean checks)
  fail: Registry.slash in the same tx: 50 % refunds the agent, 30 % to the verifiers that caught it, 20 % treasury;
        node suspended; the agent stops paying it and reroutes the job to an honest node
coordinator anchors each verdict as a memo on the native XRP Ledger (Testnet)
```

### Why a re-run is a proof

The sandbox is pinned by multi-arch image digest, runs with no network, read-only root, a non-root user, dropped capabilities, fixed CPU/memory/pid limits and a fixed environment (`TZ`, `LANG`, `PYTHONHASHSEED`, `SOURCE_DATE_EPOCH`, `HOME`). The runner records only the program's output (or pass/fail per test), never timings. `result_hash = sha256(canonical_json(result))`. The same job gives the same hash on every honest machine; we ran the 20 RL rollouts twice each, and across node restarts, with identical hashes. A timeout is a valid deterministic result. The LLM is not part of what is verified: it runs on the laptop and only writes the programs; what the nodes run and what the verifiers re-run is the deterministic program.

### Honest framing

- Only a **sample** is re-run. The bond makes cheating unprofitable: with price *p* and sampling rate *s*, the expected unearned payout before being caught is *p(1−s)/s*.
- A fabricated output that happens to equal the honest output is undetectable **and harmless**: the result is correct. For a script job that practically never happens; for RL grading, a cheater's "all passed" is right on a correct rollout and caught on the first buggy one.
- Decentralized compute, marketplaces and agent payments are not new. Exact verification of deterministic jobs, with payment gated on it and settled in dollars on XRPL, is the part that is.
- GPU work is not bit-reproducible, so it cannot be checked this way; this design is for deterministic CPU jobs only, never GPU inference.
- Prime Intellect proved decentralized RL works and verifies GPU rollouts statistically. Gradewire does not train anything and does not run models on the network; it sells exactly checkable CPU work, and pays per verified job in dollars.
- Demo bonds and prices are 0.01 RLUSD because the team budget is 20 testnet RLUSD; the contract takes any size.

## Run it

Requirements: Node 22.13 or later, Docker, Foundry (only to redeploy). One `.env` (never committed; see `.env.example`) with the AP4M agent and merchant keys from the participant portal, plus the keys `scripts/keys.mjs` generates, The ask agent calls Claude through the local `claude` CLI by default (the demo laptop's setup); set `ANTHROPIC_API_KEY` to use the Anthropic SDK instead.

```bash
npm install
node --env-file=.env scripts/keys.mjs              # coordinator, 3 operators, dev approver (+ gas)
# redeploy only if you changed operators/approver (needs RLUSD_TOKEN, APPROVER_ADDRESS,
# TREASURY_ADDRESS and OPERATOR1..3_ADDRESS in the environment; then update deployments/testnet.json):
# (cd contracts && forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.xrplevm.org --broadcast)
node --env-file=.env scripts/fund-nodes.mjs 4401 4402 4403   # gas + 0.01 RLUSD bond per node
scripts/demo-up.sh                                 # coordinator, 3 verifiers, 2 honest nodes, 1 cheater
open http://127.0.0.1:4500/
scripts/ask.sh "How many primes are below 10 million, and what is the 100,000th prime?" --parts 3
scripts/trainer.sh --jobs 9                        # second workload: RL reward grading, same network
scripts/demo-down.sh
```

**Nodes on other laptops:** `scripts/tunnel.sh 4500` on the team laptop, then on any Mac with Docker: `scripts/join.sh --coordinator https://<tunnel> --label "Node Sam"`; fund the address it prints with `scripts/fund-nodes.mjs --address 0x…`. Runbook: `docs/JOIN.md`.

### Ask it something

```bash
scripts/ask.sh "your question" [--parts N] [--max-price 0.01] [--min-score 0.8] [--no-settle] [--dry-run] [--node URL]
```

The agent (`packages/ask/index.mjs`) calls Claude on the laptop (the local `claude` CLI by default, or the Anthropic SDK when `ANTHROPIC_API_KEY` is set; model from `ASK_MODEL`, default `claude-sonnet-5-5`) to split the question into `--parts` small deterministic Python programs. Each program becomes a `python-script` job sent to a different node, in parallel, through the same paying client the trainer uses (`packages/trainer/engine.mjs`): nodes ranked by price ÷ score, `--max-price` and `--min-score` as the agent's own limits, one capped AP4M Channel per node.

In the terminal you see, per job: the node chosen, the 402, the Voucher signed and redeemed (`VoucherRedeemed` link), the output coming back with its `result_hash`, then `sampled`/`not sampled` and the verdict as it lands. Honest nodes earn trust as the run goes: the agent prints `trust earned: 2 jobs at a time` after a node's first clean check and lets it hold more unverified work. A node that fabricates its output is caught on its first sampled job (a new node's every job is re-run until it has 3 clean checks, then 50 %): the agent prints the FAIL verdict, the slash and refund transaction, stops paying that node and resends the job to an honest one. The final answer is composed only after every job's verdict is pass or not-sampled; `--no-settle` skips the end-of-run `settle` so the stage demo stays short, `--dry-run` writes the programs without paying anyone.

On the dashboard the same run shows up as rows in the Jobs panel with their `VoucherRedeemed` links and three verifier squares filling in, and, for the cheater, a red "FAILED verification" line, a "bond slashed … refunded to the agent" line in the feed, the caught counter turning red and the node turning **suspended** with score 0.

Individual processes: `scripts/coordinator.sh`, `scripts/verifier.sh 1|2|3`, `scripts/node.sh [--port 4401] [--cheat] [--label "Node A"]`, `scripts/trainer.sh [--node http://127.0.0.1:4401] [--jobs 8]`. Logs go to `.state/logs/`. `node --env-file=.env scripts/channels.mjs` lists the team's AP4M Channels; `... channels.mjs close 0x…` settles and closes one.

The 3-minute stage script is in [`docs/DEMO.md`](docs/DEMO.md); submission text and the bounty checklist are in [`docs/SUBMISSION.md`](docs/SUBMISSION.md). Tier 0 wrappers for the raw AP4M demos are `scripts/demo1.sh`, `scripts/demo2-merchant.sh` and `scripts/demo2-agent.sh`.

## Sponsor integrations

### Mastercard AP4M (every payment)

Payment is the product: no result is delivered before its Voucher is redeemed. Each node is an x402 merchant built on the kit's primitives (`buildMerchantResourceChallenge`, `prepareX402Redemption`, `verifyMerchantResourceRedemption`), extended from one fixed `/resource` to a **per-job resource URL** with content computed after payment. The agent uses the kit's `buyResource` unchanged. Vouchers are cumulative per Channel, so the agent keeps **one Channel per node** and pays nodes in parallel. Settlement (`settle` per Channel at the end of a run) releases RLUSD to the team payout wallet; the agent prints the payout transaction and receipt URL.

Things we hit and handled (all retried, never skipped): the public RPC can return `null` for a just-broadcast transaction (the kit's post-redemption check fails once); the AP4M service intermittently answers with an HTML error page; the SDK's canonical JSON rejects non-integer numbers (RL jobs carry decimal rewards, so results are hashed with our own canonical JSON); the service allows **three open Channels per payout** (`ActivePayoutLimitExceeded`), so the agent treats Channels as a pool, reclaims the Channel of a node that is gone, and closes a banned node's Channel. Both sides persist state before paying, so a crash on either side never pays twice or loses a paid result.

**Status:** implemented and exercised live on XRPL EVM Testnet through the RL trainer; every payment in the proof table below went through this path. The ask agent drives the same engine.

### Quicknode

`POST /webhooks/quicknode` on the coordinator ingests a **Streams** payload of raw logs for the three contracts (`VoucherRedeemed`, `NewTaskCreated`, `TaskResponded`, `VerdictPosted`, `Slashed`) and routes it through the same handler as the local watcher, de-duplicated by `(txHash, logIndex)`; `QUICKNODE_WEBHOOK_SECRET` is checked against the `x-gradewire-secret` header. With `QUICKNODE_RPC_URL` set, every process reads and writes the chain through the Quicknode endpoint (`packages/shared/chain.mjs` → `makeProvider`), which splits `eth_getLogs` into 5-block chunks and backs off on the plan's 15 requests/second limit. Why it matters here: the agent's payment gating waits on `VerdictPosted`; event latency is money latency.

**Status:** the coordinator, verifiers, nodes and agent run against a Quicknode XRPL EVM Testnet endpoint (chain 1449000 confirmed over it). The webhook is self-tested with real chain logs and the dashboard tags Quicknode-sourced payments. Still to do: create the Stream in the console (chain 1449000, dataset "logs", filtered to the addresses in `deployments/testnet.json`, destination `https://<tunnel>/webhooks/quicknode`, header `x-gradewire-secret`) and join the Quicknode track in the hackathon app; runbook in `docs/QUICKNODE.md`.

### Ledger

The agent never holds a raw unlimited key: it spends from AP4M Channels with a cap (`CHANNEL_CAP`, default 0.5 RLUSD). Bond withdrawals need an **approver signature** checked on-chain (`GradewireRegistry.withdrawBond` recovers an EIP-712 `WithdrawApproval(provider, amount, nonce, deadline)`), so a stolen node key cannot drain a bond. `scripts/approve-withdraw.mjs` prints the exact typed data for a hardware wallet (`eth_signTypedData_v4`); `--dev` signs with the software `APPROVER_DEV_PRIVATE_KEY` so the flow can be exercised without a device; `scripts/withdraw-bond.mjs` submits the withdrawal with that signature.

**Status:** contract gate deployed and exercised on testnet with the software approver key (wrong signer and replay refused, proof row below); signing on a physical Ledger was not exercised (no device at the table).

### AWS Bedrock AgentCore

`packages/trainer/agentcore/agentcore_app.py` wraps the trainer as an AgentCore Runtime entrypoint exposing `gradewire.grade_rollouts` as the agent's paid tool; steps are in `packages/trainer/agentcore/README.md`.

**Status:** scaffold only; not deployed (no AWS credentials at build time).

### Native XRP Ledger

The coordinator anchors every verdict as a memo on an XRPL Testnet `AccountSet` transaction (`packages/coordinator/anchor.mjs`); the dashboard links each anchor to testnet.xrpl.org. On by default; `ANCHOR_XRPL=0` turns it off. The coordinator's XRPL wallet is created and faucet-funded on first use.

**Status:** implemented and exercised (proof row below).

## Proof (XRPL EVM Testnet, Oct 24–25 2026)

| What | Transaction |
|---|---|
| Contracts | Registry [`0x8362dA75…B7C3`](https://explorer.testnet.xrplevm.org/address/0x8362dA758E5Bf63bc21F2e7BB0Ec49c89879B7C3), ServiceManager [`0xA85AB975…b62f`](https://explorer.testnet.xrplevm.org/address/0xA85AB97518c6d118A521e8c2D7df561e5a2Bb62f) |
| A paid job (`VoucherRedeemed` on the AP4M PaymentLedger) | [`0xa9b9768e…3da1`](https://explorer.testnet.xrplevm.org/tx/0xa9b9768e1ffb82256bdde171da9bbae3474febc1fab3fc9fe7653dcad7043da1) |
| A pass verdict (2-of-3 verifiers reproduced the hash) | [`0xe35c6770…b2f`](https://explorer.testnet.xrplevm.org/tx/0xe35c677098e8f66e47bfd7eb5bf8ea67d868511df087438db9a8f406fc617b2f) |
| **The catch**: fail verdict + slash + refund in one tx | [`0x6b616086…80a6`](https://explorer.testnet.xrplevm.org/tx/0x6b616086ffb1d1944f76f659260e3ee8bbed3da55ce425de9b32c385107b80a6): 0.005 RLUSD to the agent, 0.0015 to each catching verifier, 0.002 treasury; node suspended |
| **The catch, live rehearsal** (agent watching: ban + reroute + refund) | [`0xaa7dc281…a50a`](https://explorer.testnet.xrplevm.org/tx/0xaa7dc281266cfb2ae18905afabbf0688f93a6b82b77ba166dae290897614a50a) |
| A verdict anchored on the native XRP Ledger (AccountSet memo) | [`02486539…D428`](https://testnet.xrpl.org/transactions/02486539AF9ED40C5F3BFBE0A5311A3E8083B353D5E60D240439413D8075D428) |
| Approver-gated bond withdrawal (wrong signer and replay refused) | [`0x8941b771…c911`](https://explorer.testnet.xrplevm.org/tx/0x8941b771e7e90ff49622306b37c08cfd7a09689e6de8f98ad2503a3e7415c911) |
| RLUSD settlement to the team payout wallet | payout wallet [`0xfef51cf8…dbfc`](https://explorer.testnet.xrplevm.org/address/0xfef51cf8a51f290b2f7bbb06890b12018631dbfc) (token transfers tab; the agent prints each `payout_tx` and receipt URL at the end of a run) |

The transactions above were produced by the RL trainer workload (`python-fn-tests` jobs); the ask agent sends `python-script` jobs down the same payment and verification path.

## What was cut

Nomad (direct HTTP dispatch instead), VictoriaMetrics (SQLite telemetry table), WireGuard, real RL training (pre-generated rollouts in `tasks/`), EigenLayer core contracts (standalone AVS-pattern contracts, same events). Not exercised against the sponsor service for lack of an account or device: Quicknode Stream (the RPC endpoint is live), physical Ledger signing, AgentCore deployment. Never cut: live AP4M payments, the verification re-run, the cheater catch.

## Repo map

```
packages/ap4m         AP4M kit, vendored as-is (+ .cjs copies for ESM)
packages/shared       canonical JSON, hashing, job schema (python-script, python-fn-tests), chain helpers, EIP-712 types
packages/ask          the ask agent: question -> deterministic programs -> paid, verified jobs -> answer
packages/node         node: x402 per-job merchant, sandbox runner, join/bond/telemetry
packages/coordinator  registry, sampling, verdict watcher, scores, SSE, webhook, XRPL anchor
packages/verifier     operator process
packages/trainer      paying engine shared by ask and trainer (engine.mjs); RL trainer CLI (+ AgentCore scaffold)
packages/dashboard    one HTML page over SSE
contracts/            Foundry: Registry, ServiceManager, tests, deploy script
deployments/          testnet.json (addresses, operators) and ABIs
sandbox/runner.py     deterministic runner inside the container (scripts and tests)
tasks/rollouts.mjs    20 hermetic toy RL rollouts (10 tasks × good/bad)
scripts/              keys, funding, launch, ask, trainer, demo, Channel list/close, Ledger-gated withdrawal
docs/DEMO.md          stage script
docs/SUBMISSION.md    submission text and bounty checklist
```

Credit: the reliability-monitoring flowchart that this design grew from is the Quok.it senior-design poster (Penn, Team 20).
