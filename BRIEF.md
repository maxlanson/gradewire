# Verified Reward Grading for RL — Build Brief

Oct 24, 2026 · Max

## Read this first (for the AI receiving this brief)

You are the lead engineer and product partner for a four-person team at a 36-hour hackathon that runs October 24–25, 2026 in New York. Your job is to help them ship a working demo of the product below and win as many sponsor prizes as possible with one project.

Ground rules:

- **Do not invent the Mastercard AP4M API.** Section 3 lists the SDK file names. Ask the team for those files (or download them from the portal) and read them before writing any payment code. The integration guide and `AGENTS.md` in the kit are the source of truth.
- **Only work done during the hackathon counts toward judging.** Write everything fresh.
- **Facts marked "verify" are unconfirmed.** Check them at the sponsor booths or in the docs before building on them.
- **Never fake a demo step.** Mastercard's judges require a live run with real testnet transactions. If something doesn't work, cut scope rather than mock it, and say what was cut.
- **Prefer the smallest thing that works.** The build order in section 14 is ordered by what earns points first.
- **Keep claims honest.** Section 5 lists what this product can and cannot claim versus competitors. Use those exact framings in the pitch.

What to do first:

1. Read sections 1, 2, 3 and 14.
2. Ask the team who has which laptop (GPU or not, OS) and whether they have registered for the Mastercard bounty and been funded at the booth.
3. Get the AP4M Demo 2 (local merchant + agent paying over HTTP 402) running end to end. Nothing else matters until that works.
4. Then follow the build order.

## 1. The product in one paragraph

**Working name: Gradewire** (placeholder; rename freely). Gradewire is a network where anyone's computer earns money grading reinforcement-learning (RL) rollouts for AI training runs. A training loop sends a batch of model attempts (for example, code the model wrote) to provider machines, which run the tests in a locked-down sandbox and return a score. A sample of grades is re-run by independent verifiers; because the grading is deterministic, a re-run either matches exactly or proves the provider cheated. The training loop pays per verified grade in RLUSD through Mastercard's AP4M agent-payment rails on the XRPL EVM sidechain, and each next payment waits on the last check.

**Pitch line:** "RL runs on rewards. We make every reward checkable, and nobody gets paid for a grade that doesn't hold up."

**Plain-English version:** Training an AI to code is like a student doing practice problems. Someone has to grade every answer. Gradewire is a crowd of graders on ordinary computers. Spot-checkers re-grade a sample; because grading code is exact, a fake grade is caught for certain. Graders are paid per grade, only while their grades keep checking out.

Three parts, mirroring the Quok.it poster this idea grew from:

| Part | Runs where | Does what |
| --- | --- | --- |
| Provider node (grader) | Any laptop or desktop, GPU optional | Registers, passes a hardware check, runs sandboxed grading jobs, sells them over HTTP 402, streams health telemetry |
| Coordinator + verifier network | Team's server + 3 verifier processes | Registry, scheduling (Nomad), telemetry database, re-runs sampled jobs, posts pass/fail verdicts on-chain, handles slashing and refunds, dashboard |
| Buyer (RL trainer agent) | Team laptop, optionally on AWS Bedrock AgentCore | Sends rollouts for grading, picks providers by reliability and price, pays per verified grade, reroutes on failure |

## 2. Hackathon context and what judges reward

The event is the **AI & Fintech XRPL Hackathon**, hosted by XRPL Commons in New York, October 24–25, 2026, the weekend before Ripple's Swell conference. Partners: Ripple, XRPL Foundation, Mastercard, Ledger, AWS, Quicknode. The prize pool is about $46,000, and sponsor prizes stack on top of a main-track prize. The event ends Sunday, October 25 at 8:00 PM EDT (per the Luma listing); confirm the submission cutoff in the hackathon app.

Hard rules:

- Every project must be built on the XRP Ledger. The XRPL EVM sidechain counts as XRPL; anchoring verdicts on the native ledger as well strengthens the story.
- Existing projects may enter, but only what is built during the 36 hours is judged.

### Prizes this project targets

| Prize | Amount | What it requires | How Gradewire hits it |
| --- | --- | --- | --- |
| Agentic Finance track | $6,000 | Tools that let AI agents make payments and manage money on XRPL, autonomously and safely | The RL trainer is an autonomous agent buying grading and managing its spend |
| Mastercard partner prize | $6,000 | An agent that pays autonomously with AP4M over HTTP 402, RLUSD settling on XRPL EVM | Every grade is paid per request; payment is load-bearing |
| Quicknode | $3,000 | Best use of Quicknode (RPC, Streams, webhooks); the team must join the Quicknode track in the hackathon app to be eligible | Streams watch payment and verdict events and feed the dashboard and scoring |
| Ledger (Agentic Finance) | $3,000 | Ledger device as the trust layer: human approval for high-risk actions, scoped capabilities instead of raw keys | Provider bond withdrawals and buyer budget increases above a threshold need a Ledger signature |
| AWS (Agentic Finance) | $2,000 | Built on Bedrock AgentCore with x402 / RLUSD payments | The trainer agent runs on AgentCore and calls Gradewire as a paid tool |

Every prize on the site, and why the others are out of reach for this project:

| Prize | Amount | Fits Gradewire? |
| --- | --- | --- |
| Track: Agentic Finance | $6,000 | Yes, main track |
| Track: Lending & Borrowing | $6,000 | No; one track per project |
| Track: Protocol Innovation | $6,000 | No |
| Track: Why Not | $4,000 | No; one track per project |
| Mastercard | $6,000 | Yes |
| Quicknode | $3,000 | Yes, after joining its track |
| Ledger: Agentic Finance | $3,000 | Yes |
| Ledger: Protocol Innovation | $4,000 | No; tied to that track |
| Ledger: Why Not | $3,000 | No; tied to that track |
| AWS: Agentic Finance | $2,000 | Yes |
| AWS: Lending & Borrowing | $2,000 | No |
| AWS: Why Not | $1,000 | No |

The realistic ceiling for this project is $20,000 (Agentic Finance $6,000, Mastercard $6,000, Quicknode $3,000, Ledger $3,000, AWS $2,000). Partner sub-prizes appear tied to the track a project enters; confirm with organizers if aiming for more.

Pick **Agentic Finance** as the main track. Do not enter Lending & Borrowing with this project.

### Mastercard's judging criteria (from the AP4M developer guide)

1. **Autonomy:** the agent receives a 402, decides to pay, signs and submits the voucher with no human in the loop.
2. **Use case clarity:** the payment must be essential to the product, not decoration.
3. **On-chain proof:** a `VoucherRedeemed` event visible on the XRPL EVM Testnet explorer.
4. **RLUSD settlement:** the merchant's payout wallet balance actually changes.
5. **Demo quality:** the full flow runs live in 3 minutes, nothing pre-recorded.
6. **Creativity:** extra credit for going beyond the starter examples (new merchant types, multi-step agent reasoning, real data sources).

Mentor office hours were Saturday 4–5 PM; check the schedule for Sunday sessions.

## 3. Mastercard AP4M: what we know

AP4M is Mastercard's agent-payment kit for this hackathon. It runs on the **XRPL EVM Testnet (chain ID 1449000)** with EVM contracts and EIP-712 typed-data signatures, and settles in **RLUSD**, Ripple's dollar stablecoin. It is mostly JavaScript.

### Payment flow, as the developer guide describes it

1. The agent holds a funded budget and opens a **payment channel** with a spending limit.
2. The agent signs a **payment voucher** locally (EIP-712). The private key never leaves the machine.
3. The voucher is **redeemed on-chain**, which emits a `VoucherRedeemed` event (from the PaymentLedger contract).
4. The service automatically sends **RLUSD to the merchant's payout address**.

The x402 pattern on top: a merchant endpoint answers an unpaid request with HTTP 402 and payment terms; the agent pays and retries with proof; the merchant serves the response.

Verify in the SDK before designing around it: whether vouchers are cumulative (each voucher states the running total) or per-payment, how a channel is closed or topped up, and who submits the redemption (agent, merchant or the service).

### Kit files (served from hackathon.ap4m.build)

| File | Size | Purpose |
| --- | --- | --- |
| `/sdk/ap4m-hackathon-sdk.js` | 15.5 KB | Core SDK |
| `/sdk/ap4m-x402.mjs` | 27.5 KB | x402 helpers for merchants and agents |
| `/sdk/example-x402-agent.mjs` | 4.5 KB | Demo 2 agent |
| `/sdk/example-x402-merchant.mjs` | 3.0 KB | Demo 2 merchant |
| `/sdk/AGENTS.md` | 4.1 KB | Rules for AI coding tools; put it in the repo root |
| `/docs/x402.md`, `/docs/api-reference.md` | n/a | Returned an empty body without login; open them signed in to the portal |

### Setup steps for the team

1. Fill out Mastercard's registration form (linked in the October 23 email "Mastercard Bounty Challenge – Important Details" and on the prize page).
2. Visit the Mastercard booth to be activated and funded with testnet RLUSD.
3. Log in at hackathon.ap4m.build/participant. On "My setup," add an **agent wallet** and a **separate merchant payout address**. Keep the payout key safe.
4. Get testnet XRP for gas from the XRPL EVM Testnet faucet.
5. Run Demo 1 (`node ap4m-agent.js`, one pre-filled file) to confirm payments work.
6. Run Demo 2 (local merchant + agent paying over 402). This is the skeleton every provider node and the trainer will reuse.
7. Submit project details through Mastercard's own AP4M submission form, in addition to the main hackathon submission.

Status as of Saturday 6:45 PM: the team is activated and funded with 20 RLUSD (Mastercard email, 3:47 PM). Still to do: register the merchant wallet in the portal (opens the payment channel) and, at the end, the AP4M submission form.

The hackathon app's Resources tab also links Mastercard Slides, a Mastercard MCP server and Agentpay; read the slides for extra hints.

### One payout address per team?

In a real marketplace each provider has its own payout address. The portal may only allow one per team. Ask at the booth. If only one is allowed, the coordinator is the merchant of record: buyers pay the coordinator per grade, and the coordinator pays providers in a second step (plain RLUSD transfers). Say so in the demo.

## 4. Problem and market

RL post-training is now the main way models learn to code and use tools, and it runs on scored attempts. Grading those attempts is a large, parallel, latency-tolerant workload that ordinary computers can do, but nobody can currently trust a stranger's grade.

**How RL post-training splits.** It breaks into a huge pile of communication-light "rollouts" that run fine on consumer hardware and a small, heavy weight-update step ([Simback](https://x.com/KSimback/status/2074967176726089937)). Gensyn's research argues RL fits decentralized setups because it depends on many diverse rollouts more than frequent parameter syncing ([IOSG](https://x.com/IOSGVC/status/2003446318153298020)).

**Where the reward comes from.** For coding RL, the largest RL category, a rollout's reward usually comes from running the model's code against tests in a sandbox. That is CPU work, and with a pinned environment it is deterministic.

**Why determinism matters.** GPU inference does not reproduce bit for bit across machines, even with controlled drivers and libraries, so exact re-computation fails as a check for GPU work ([Lilypad paper](https://arxiv.org/html/2501.05374v1)). Deterministic CPU grading does reproduce, so a re-run is a definitive check. This is the technical heart of the pitch.

**The market.** RL environments became a distinct infrastructure layer in 2025–2026, reportedly estimated at around $1B in annual revenue by mid-2026; Anthropic has reportedly discussed spending over $1B on them, and OpenAI reportedly buys browser "UI gyms" ([Zylos summary](https://zylos.ai/research/2026-07-15-rl-environments-as-a-service-agentic-training-infrastructure/)). Vendors fall into three groups: human-data companies (Scale AI, Surge AI, Mercor, Turing), environment-native startups (Mechanize, Fleet AI, HUD, Veris AI, Plato, Bespoke Labs) and open hubs such as Prime Intellect's, with sandbox infrastructure from Modal and E2B underneath ([Troveo](https://www.troveo.ai/resources/rl-environment-companies)).

**The gap.** The sandbox layer under all those environments is centralized. Gradewire is that layer, decentralized onto people's own computers, with every paid grade checkable.

**Who buys first.** Frontier labs buy through large direct contracts, not open marketplaces. Pitch Gradewire to smaller labs, open-source RL teams and agent startups running their own RL, and treat frontier labs as the long-term customer.

## 5. Competitors and honest positioning

Gradewire's defensible difference is narrow: **exact verification of deterministic grading, with each payment released only while checks pass, settled in dollars on XRPL.** The marketplace, hardware checks and agent payments on their own are not new.

| Player | What they do | Overlap with Gradewire | Where Gradewire differs |
| --- | --- | --- | --- |
| [Prime Intellect](https://www.primeintellect.ai/blog/intellect-2-release) | Decentralized RL; TOPLOC verifies GPU rollouts; on-chain event triggers validators; bad workers removed | Closest. Same "verify contributions, drop cheaters" loop | They verify GPU rollouts probabilistically; we grade on CPU with exact checks and pay per verified grade in RLUSD. Crypto-backed seed, $130M Series A in July 2026, no token as of October 2026 |
| Gensyn (RL Swarm) | Decentralized collaborative RL | Same space | Research swarm, not a paid grading market |
| [Hyperbolic](https://www.hyperbolic.xyz/blog/deep-dive-into-hyperbolic-proof-of-sampling) | Decentralized GPU marketplace; Proof of Sampling with EigenLayer; x402 for its inference API | Sampling verification, EigenLayer, agents paying over x402 | Verification there deters cheating after payment; here it gates the next payment. GPU rental, not grading |
| io.net, Akash | Decentralized GPU rental by the hour or lease, token payouts | Install-and-earn supply | Pay for time, verify hardware only; providers paid in volatile tokens |
| Modal, E2B, Daytona | Centralized sandboxes for agents | The workload itself | Centralized; no verification needed or offered |
| Kilawatt Cloud, GPU-Bridge | Agents pay for GPUs over x402 in USDC on Base | Agent pays per job | Centralized brokers; refunds after failure; Base, not XRPL |

### Reliability is the category's documented weakness

SemiAnalysis's ClusterMAX 2.0 (November 2025) rated Hyperbolic "Underperforming," citing dropped connections, instances stuck in an unknown state and a provisioning failure; Akash, Salad Cloud and Aethir sit in the same tier ([ClusterMAX](https://www.clustermax.ai/cloudreview/hyperbolic)). Gradewire answers this with live health telemetry, automatic rescheduling and pay-only-for-finished-work. Note: ClusterMAX 3.0 (September 2026) is published as an image and was not checked.

### Claims to make

- "Every grade we pay for is checkable, and a checked grade is right or wrong, not probably right."
- "A failed check stops payment immediately; the provider's bond refunds the buyer."
- "Providers are paid in dollars (RLUSD), not a token."
- "Prime Intellect proved decentralized RL works; we make grading it trustworthy and paid per result."

### Claims not to make

- That every grade is verified. Only a sample is re-run.
- That decentralized compute, marketplaces or agent payments are new.
- That GPU work is exactly verifiable. Only deterministic CPU grading is.
- That this beats Prime Intellect at RL training. It doesn't train anything.

## 6. System architecture

The architecture is the Quok.it flowchart (registration, hardware validation, AVS attestation, Nomad clients, telemetry, alerts, error handler, dashboard) with two additions: a paying buyer agent and per-job verification that gates payment.

```text
                 Payment only moves while verification keeps passing

 RL trainer agent ──job + 402 pay──▶ Provider nodes                Coordinator
 (builds jobs, pays per grade,        Grader A (sandbox, /grade) ─results──▶ Registry + scheduler (Nomad, scores, sampling)
  waits on each verdict)              Grader B (health metrics) ─telemetry─▶ Telemetry + alerts (VictoriaMetrics)
        │      ▲                      Grader C (cheater)                     Error handler (reroute, stop paying)
        │      └──────────── stop paying, reroute ─────────────────────────────────┘
        │
        │ pays per grade (x402)        3 verifier operators                   Dashboard
        │                              (re-run sampled jobs, sign)            (live scores, payments, verdicts, refunds)
        ▼                                     │ signed verdicts                       ▲ Quicknode Streams
 XRPL EVM Testnet (chain 1449000):            ▼                                       │
   AP4M PaymentLedger            GradingServiceManager ─────────▶ Registry + bonds ───┘
   (VoucherRedeemed, RLUSD out)  (VerdictPosted, 2 of 3 quorum)   (slash, refund the buyer)
```

The trainer pays each grader per grade through AP4M; graders report results and telemetry to the coordinator; sampled jobs go to the three verifiers, whose signed verdicts land in the service-manager contract; a failed verdict slashes the cheater's bond and refunds the trainer, while the error handler stops payments and reroutes work. Quicknode Streams carry on-chain events to the dashboard.

| Poster box (Quok.it) | Gradewire component | Change |
| --- | --- | --- |
| Registration + GPU provider | Provider node `init` + `/providers/register` | Same idea; CPU graders, GPU optional |
| HW validation | Benchmark challenge with known answers | Same |
| EigenLayer AVS (report) | GradingServiceManager | Also verifies every sampled job, not just registration |
| Nomad server + clients over WireGuard | Coordinator scheduler + provider nodes | Same; WireGuard is a stretch goal |
| Telemetry → VictoriaMetrics → alerts | Same | Feeds the reliability score too |
| Error handler | Error handler | Also stops payment and reroutes jobs |
| Dashboard (backend + frontend) | Dashboard | Adds payments, verdicts, refunds and explorer links |
| (none) | RL trainer agent + AP4M payments | New: the paying customer |

## 7. End-to-end flows

Four flows make up the product: a provider joins, a batch gets graded and paid, a sample gets verified, and a failure gets handled.

### A. Provider registration

1. Provider installs the node and runs `gradewire-node init`. It generates an EVM keypair (identity and signing key) and reads the machine's specs (CPU model, cores, RAM, OS, Docker version, GPU if any).
2. Node calls `POST /providers/register` on the coordinator with specs, public key and its x402 endpoint URL.
3. Coordinator issues a **benchmark challenge**: a fixed grading job set with known answers plus a time limit sized to the claimed specs.
4. Node runs it and returns results signed with its key.
5. Coordinator checks the answers and timing. Pass → creates an AVS task "attest provider X". Verifier operators re-run a slice and sign; the aggregate verdict is posted on-chain (`ProviderAttested` event).
6. Provider posts a **bond** in RLUSD to the registry contract (section 9).
7. Node joins the Nomad cluster as a client (over WireGuard if time allows) and starts streaming telemetry. Status: `active`, reputation starts at the floor.

### B. A batch gets graded and paid (happy path)

1. The trainer finishes a group of rollouts, packages each as a **grading job** (section 11) and asks `GET /providers?kind=grader&min_score=...` for candidates ranked by price and reliability.
2. Trainer calls the chosen provider's `POST /grade` with the job. Provider replies **HTTP 402** with the price.
3. Trainer's AP4M client pays (voucher signed locally, redeemed on-chain) and retries with payment proof. This is the Mastercard moment.
4. Provider runs the job in the sandbox, returns the result (`exit_code`, per-test pass/fail, `result_hash`, signature) and reports it to the coordinator.
5. Coordinator records the result and decides, by the provider's sampling rate, whether to create a verification task.
6. **Pipelining:** the trainer may send job N+1 while job N is being checked, but never more than one unverified job outstanding per provider. Payment for N+1 is held until N's verdict is in or N was not sampled.
7. The reward goes to the trainer's update step.

### C. A sampled job gets verified

1. Coordinator calls `createVerificationTask(jobId, providerResultHash)` on the service-manager contract.
2. Each verifier operator sees the `NewTaskCreated` event, fetches the job spec, re-runs it in an identical sandbox and computes its own `result_hash`.
3. Each operator signs `(taskId, match: bool, theirHash)` and submits. When a quorum (2 of 3 in the demo) agrees, the contract emits `VerdictPosted(taskId, provider, pass)`.
4. Quicknode Streams (or the coordinator's own listener as a fallback) picks up the event; the coordinator updates the provider's score and tells the trainer.

### D. A check fails

1. `VerdictPosted(..., pass=false)` lands.
2. The trainer stops sending jobs and payments to that provider immediately.
3. Coordinator calls `slash(provider, jobId)`: part of the bond refunds the trainer for the bad grade, part rewards the verifiers, the rest is burned or sent to a treasury (demo: split refund 50%, verifiers 30%, treasury 20%; tune freely).
4. Provider status → `suspended`; its unverified jobs are re-sent elsewhere.
5. Separately, **health failures** (node offline, telemetry flatlines, sandbox crash) are not cheating: no slash, but the job is rescheduled, unpaid work is not paid, and the reliability score drops.

## 8. Determinism and verification spec

The whole product rests on one property: the same job on any honest machine produces the same `result_hash`. Enforce it with a pinned environment and a canonical result format, and only offer "verified" mode for jobs that meet these rules.

### Sandbox rules (every grading run, provider and verifier alike)

- **Image pinned by digest**, never by tag: `python@sha256:...`. The job spec names the digest.
- **No network:** `docker run --network none`.
- **Fixed resources and limits:** `--cpus 1 --memory 512m --pids-limit 128 --read-only` plus a writable `--tmpfs /tmp:size=64m`.
- **Fixed environment:** `TZ=UTC`, `LANG=C.UTF-8`, `PYTHONHASHSEED=0`, `SOURCE_DATE_EPOCH=0`, a fixed `HOME`, no inherited host variables.
- **Fixed working directory and file order:** the job's files are written in sorted path order with fixed timestamps.
- **Timeout** from the job spec (default 20 s wall clock). A timeout is a valid, deterministic result (`status: timeout`), not an error. Pick timeouts generous enough that honest slow machines don't hit them.
- **Run as non-root** (`--user 65534:65534`), drop all capabilities (`--cap-drop ALL`), `--security-opt no-new-privileges`.

### What gets hashed

Use a structured result, never raw logs (logs contain timings and addresses):

```json
{
  "job_id": "...",
  "spec_hash": "sha256 of canonical job spec",
  "status": "ok | timeout | error",
  "exit_code": 0,
  "tests": [{"name": "test_add", "passed": true}, {"name": "test_neg", "passed": false}],
  "reward": 0.5
}
```

`result_hash = sha256(canonical_json(result))` with keys sorted, no whitespace, tests sorted by name. Use pytest with `--junitxml` or a tiny custom runner that prints JSON, and strip durations.

### Flaky tests

Tests that read the clock, use randomness or depend on ordering will break determinism. For the hackathon, generate your own task set (simple functions plus pure unit tests) so this never arises. For production, reject job specs whose tests fail a three-run determinism check at submission.

### Sampling rates

The chance a provider's job is re-run depends on its record:

| Provider state | Verified jobs so far | Sampling rate |
| --- | --- | --- |
| New | 0–19 | 50% |
| Building trust | 20–199 | 20% |
| Trusted | 200+ with no failures | 5% |
| Any failure in the last 7 days | n/a | 100% until 20 clean jobs |

For the demo, set rates high (50% or more) so a verification happens on stage.

### Canary jobs

The coordinator mixes in jobs whose correct `result_hash` it already knows. A wrong answer on a canary fails immediately without waiting for verifiers. Canaries must be indistinguishable from real jobs (same task format, random IDs).

### Copying attack

A lazy provider might copy another provider's answer instead of running the job. Defenses: each job goes to one provider only (so there is nothing to copy), and verification re-runs happen on verifier machines, not other providers.

## 9. Payments, bonds, slashing and refunds

Three rules govern money: pay per grade over 402, never pay ahead of an open verification, and back every provider with a small bond that a failed check slashes to refund the buyer.

### Pricing (demo values, tune freely)

| Item | Demo value | Notes |
| --- | --- | --- |
| Price per grade | 0.01 RLUSD | Shown in the 402 response |
| Price per batch (if per-grade on-chain redemption is too slow) | 0.10 RLUSD per 10 grades | Check AP4M gas and latency first |
| Provider bond | 5 RLUSD | Posted at registration |
| Slash on a failed check | Whole bond | Split: 50% refund to buyer, 30% verifiers, 20% treasury |
| Verifier fee | 0.002 RLUSD per verification | Paid by the coordinator from a fee margin |

Note: the team's AP4M allocation is 20 RLUSD total, so keep bonds and prices small enough for several demo runs.

### Payment gating

- At most **one unverified job per provider** may be in flight. The next payment waits until that job is verified or known not to be sampled.
- A job the provider never returned is never paid.
- If per-job redemption is slow, gate per batch instead: the trainer pays for batch N+1 only after batch N's sampled checks pass.

### Why a small bond is enough

A cheater skips the work and collects payment on every job that isn't sampled, until the first sampled job catches them. With sampling rate s and price p per job, the expected unearned payout before being caught is G = p × (1 − s) / s.

Cheating loses money when the bond B exceeds G. At p = 0.01 and s = 0.05 (the lowest rate, for trusted providers), G = 0.19 RLUSD, so a 5 RLUSD bond is about 26 times the expected gain. The bond's real job is making every fake identity cost money (io.net was hit by a fake-GPU Sybil attack in April 2024).

### Refund path

On `VerdictPosted(pass=false)`, the registry contract transfers the buyer's refund share from the slashed bond straight to the buyer's wallet in the same transaction. Show this balance change on stage.

## 10. Smart contracts on XRPL EVM

Two contracts on XRPL EVM Testnet do the on-chain work: a registry that holds bonds and slashes them, and a service manager that runs verification tasks the way an EigenLayer AVS does. Try real EigenLayer first, and switch to the standalone version if it isn't deploying by Sunday 9 AM.

### Path A: EigenLayer AVS (preferred, riskier)

Fork Layr-Labs `hello-world-avs`. Its contract emits a task, operators pick it up and write signed responses back on-chain, and EigenLayer requires at least one on-chain provable event, usually an aggregated ECDSA or BLS signature ([EigenLayer docs](https://docs.eigenlayer.xyz/developers/how-to-build-an-avs)). The template deploys its own copy of EigenLayer's core contracts to a local chain; point its deploy scripts at XRPL EVM Testnet instead (chain ID 1449000, RPC from Quicknode or the public endpoint). Expect gas-limit tweaks. There is no real restaked ETH on XRPL EVM, so economic security is simulated; say so in the pitch.

### Path B: standalone AVS-pattern contracts (fallback, safe)

Same events and flow, no EigenLayer dependency. Pitch line: "AVS-pattern verification, EigenLayer-ready."

```solidity
// GradewireRegistry.sol — bonds and slashing (sketch)
interface IGradewireRegistry {
  event ProviderRegistered(address indexed provider, string endpoint);
  event ProviderAttested(address indexed provider, bytes32 benchmarkHash);
  event Bonded(address indexed provider, uint256 amount);
  event Slashed(address indexed provider, bytes32 indexed jobId, address buyer, uint256 refund, uint256 verifierReward);

  function register(string calldata endpoint) external;
  function bond(uint256 amount) external;            // pulls RLUSD via transferFrom
  function withdrawBond() external;                    // after cooldown; Ledger-gated in the UI
  function slash(address provider, bytes32 jobId, address buyer) external; // only ServiceManager
}

// GradingServiceManager.sol — verification tasks (sketch)
interface IGradingServiceManager {
  event NewTaskCreated(uint32 indexed taskId, bytes32 jobId, address provider, bytes32 providerResultHash);
  event TaskResponded(uint32 indexed taskId, address indexed operator, bool matched, bytes32 operatorHash);
  event VerdictPosted(uint32 indexed taskId, address indexed provider, bool pass);

  function createVerificationTask(bytes32 jobId, address provider, address buyer, bytes32 providerResultHash) external returns (uint32);
  function respondToTask(uint32 taskId, bool matched, bytes32 operatorHash, bytes calldata signature) external;
  // Emits VerdictPosted once QUORUM (2 of 3) operators agree; on pass=false calls registry.slash(...)
}
```

Implementation notes:

- Operators are an allowlist of three addresses set at deploy time (the team's three verifier processes).
- `respondToTask` recovers the signer from an EIP-712 signature over `(taskId, matched, operatorHash)` and rejects non-operators and duplicates.
- Bonds are in RLUSD. Verify that RLUSD on XRPL EVM Testnet is a standard ERC-20 and get its address from the AP4M SDK or the booth.
- Use Foundry (`forge`) for build, test and deploy.

### Optional: anchor on the native XRP Ledger

For extra "built on XRPL" credit, the coordinator can write each verdict's hash as a memo on a 1-drop XRP payment on XRPL Testnet using `xrpl.js`. It's 30 minutes of work; do it last.

## 11. APIs and data schemas

All services speak JSON over HTTP. Only the provider's `/grade` endpoint is paywalled with x402; everything else is internal to the team's deployment.

### Grading job (sent by the trainer)

```json
{
  "job_id": "j_01HF...",
  "kind": "python-unittest",
  "image": "python@sha256:<digest>",
  "timeout_s": 20,
  "files": [
    {"path": "solution.py", "content": "def add(a, b):\n    return a + b\n"},
    {"path": "test_solution.py", "content": "from solution import add\n\ndef test_add():\n    assert add(2, 3) == 5\n"}
  ],
  "command": ["python", "-m", "pytest", "-q", "--junitxml=/tmp/r.xml"],
  "reward_rule": "fraction_passed",
  "max_price": "0.01"
}
```

`spec_hash = sha256(canonical_json(job))`. Keep jobs small (under 64 KB) for the demo.

### Provider node endpoints

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /grade` | x402 (AP4M) | Run one grading job; 402 with price when unpaid; returns the result (section 8) + `sig` |
| `GET /health` | none | Liveness and current load |
| `GET /info` | none | Specs, public key, price, version |

### Coordinator endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /providers/register` | Provider signs up; returns a benchmark challenge |
| `POST /providers/{id}/benchmark` | Submit signed benchmark results |
| `GET /providers?kind=grader&min_score=0.8` | Ranked list: id, endpoint, price, reliability score, sampling rate, status |
| `POST /results` | Provider reports a finished job: `job_id`, `spec_hash`, `result_hash`, `sig`, `buyer` |
| `GET /jobs/{id}/verdict` | `pending`, `not_sampled`, `pass` or `fail` (+ tx hash) |
| `POST /telemetry` | Batched metrics from nodes (or Prometheus remote-write into VictoriaMetrics) |
| `GET /events` | Server-sent events stream feeding the dashboard |

### Coordinator database (SQLite or Postgres)

| Table | Key columns |
| --- | --- |
| `providers` | id, address, endpoint, specs_json, status, bond, score, sampling_rate, jobs_ok, jobs_failed, registered_at |
| `jobs` | id, spec_hash, buyer, provider_id, price, paid_tx, result_hash, sampled, verdict, verdict_tx, created_at |
| `verifications` | task_id, job_id, operator, matched, operator_hash, tx |
| `incidents` | id, provider_id, kind (`health` or `fraud`), detail, at |

### Reliability score

Keep it simple and explainable: `score = 0.6 × verified_pass_rate + 0.3 × uptime_24h + 0.1 × on_time_rate`, where a fraud verdict sets the score to 0. The trainer sorts providers by `price / score` and skips anything under 0.8.

## 12. Security and threat model

The two real risks are a provider faking grades and a job harming the provider's machine; both have concrete defenses below. Everything else is a stretch-goal hardening item.

| Threat | Who | Defense in the hackathon build | Production plan |
| --- | --- | --- | --- |
| Returns "all passed" without running | Provider | Sampled re-runs, canaries, bond slash | Same, with stake-weighted sampling |
| Copies another provider's result | Provider | One provider per job; verifiers re-run independently | Same |
| Many fake identities after being slashed | Provider | Bond per identity, benchmark per identity | Hardware attestation (TEE) where available |
| Malicious job escapes the sandbox | Buyer | Docker with no network, read-only root, non-root user, dropped capabilities, limits | Firecracker microVMs or gVisor, as E2B and Modal use |
| Buyer's code is visible to the provider | Provider | Accept it: target open-source and non-sensitive tasks | Confidential computing (TEE) providers as a premium tier |
| Verifiers collude to sign false verdicts | Verifier | 2-of-3 quorum, team-run operators | Restaked operators via EigenLayer, slashing |
| Lazy verifier copies another's response | Verifier | Not handled; the team runs all three operators | Commit-reveal (operators submit a hash of their response first) |
| Buyer falsely claims a bad grade for a refund | Buyer | Refunds only follow on-chain verdicts, never buyer reports | Same |
| Honest node fails a check due to non-determinism | System | Hermetic task set; three-run determinism check on job specs | Same, plus appeals |
| Agent key theft drains the budget | Buyer | AP4M channel spending cap; keys stay local | Ledger approval above a threshold |

Keep all private keys in `.env` files that are git-ignored. Never paste keys into an AI tool's context.

## 13. Repo structure and tech stack

Use one monorepo in TypeScript/Node for everything that touches AP4M (the SDK is JavaScript), Solidity with Foundry for contracts, and Python only inside the sandbox image and the optional toy trainer.

```text
gradewire/
  BRIEF.md                  # this file
  CLAUDE.md                 # imports BRIEF.md and AGENTS.md for Claude Code
  AGENTS.md                 # copied from the AP4M kit, unmodified
  .env                      # keys, RPC URLs (git-ignored)
  .env.example              # placeholders only
  packages/
    ap4m/                   # the kit's SDK files, vendored as-is
    shared/                 # canonical JSON, hashing, job/result types, EIP-712 helpers
    node/                   # provider node: register, benchmark, POST /grade (x402), sandbox runner, telemetry
    coordinator/            # registry API, scheduler, sampler, verdict listener, slashing, SSE events, SQLite
    verifier/               # operator process: watch NewTaskCreated, re-run, sign, respond
    trainer/                # buyer agent: build jobs, pick providers, pay via AP4M, pipeline, reroute
    dashboard/              # single page: providers, scores, live jobs, verdicts, payments, explorer links
  contracts/                # Foundry project: Registry, ServiceManager, tests, deploy scripts
  sandbox/                  # Dockerfile for the grading image + JSON test runner
  tasks/                    # generated toy coding tasks with hermetic tests
  scripts/                  # demo.sh, seed providers, start the cheating node
```

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node (v24 installed) + TypeScript (`tsx` to run) | Matches the AP4M SDK |
| HTTP | Fastify or Express | Either works with the kit's x402 helpers |
| Chain client | `viem` (or `ethers` if the SDK uses it) | Match whatever the SDK imports |
| Contracts | Solidity + Foundry | Fast deploys and tests |
| Sandbox | Docker CLI via `execa` | Simplest reliable isolation |
| Orchestration | Nomad in dev mode (`nomad agent -dev`) | Mirrors the poster; drop to direct HTTP dispatch if it costs over an hour |
| Telemetry | VictoriaMetrics single binary + node exporter | Mirrors the poster; a SQLite table is the fallback |
| Event feed | Quicknode Streams webhook into the coordinator | Quicknode prize; the coordinator's own `viem` watcher is the fallback |
| Dashboard | One HTML page with SSE, no build step | Fast and demo-safe |
| Trainer | Node script that replays pre-generated rollouts; optional Python GRPO on a tiny model | The paid grading loop is the product, not the training |
| AWS | Bedrock AgentCore hosts the trainer agent; the grading call is a tool | AWS prize |

Dev machine: macOS on Apple Silicon (arm64). Pin a multi-arch image digest so verifiers on x86 machines produce the same hashes, or run all verifiers on arm64 for the demo.

## 14. Build plan, priorities and team split

Build in the order below; each tier is a working demo on its own, so a missed deadline still leaves something shippable. Work starts Saturday 7 PM; code freezes around Sunday 6 PM, two hours before the 8 PM end.

### Tiers, in order

1. **Tier 0 — Payments work (Saturday by 10 PM).** AP4M Demo 1 and Demo 2 run on the team's machines; a `VoucherRedeemed` event and an RLUSD balance change are visible on the explorer. Gate: nothing else starts merging until this passes.
2. **Tier 1 — Paid grading (Saturday by 2 AM).** Provider node serves `POST /grade` behind 402, runs a job in the sandbox, returns a canonical result and hash. Trainer pays and gets a grade. Alone, this already satisfies the Mastercard criteria.
3. **Tier 2 — Verification and gating (Sunday by 10 AM).** Coordinator samples jobs; three verifier processes re-run and respond; contracts (Path A or B, decided by 9 AM) post verdicts; trainer holds the next payment until the verdict. Cheating node exists and gets caught.
4. **Tier 3 — Money consequences (Sunday by noon).** Bonds, slashing, on-chain refund to the trainer; provider scores and rerouting.
5. **Tier 4 — Sponsor wrappers (Sunday afternoon).** Quicknode Streams feeding the dashboard; trainer hosted on AgentCore; Ledger approval for bond withdrawal or budget top-up; Nomad and VictoriaMetrics if not already in.
6. **Tier 5 — Polish (last 2 hours).** Dashboard, demo script rehearsal three times, README, both submission forms, a backup screen recording kept only for the README (the live demo must be live).

### Cut list, cut from the bottom first

1. Native XRPL memo anchoring
2. WireGuard
3. Nomad (replace with direct HTTP dispatch)
4. VictoriaMetrics (replace with a SQLite telemetry table)
5. Real RL training (replay pre-generated rollouts)
6. EigenLayer core contracts (Path B instead)
7. AgentCore hosting (lose the AWS prize, keep the rest)

Never cut: live AP4M payments, the verification re-run, the cheating-node catch.

### Team split for four people

| Person | Owns | First task tonight |
| --- | --- | --- |
| A — Payments | AP4M integration in node and trainer, payment gating, Mastercard submission | Get Demo 2 running on two laptops |
| B — Sandbox and node | Grading image, sandbox runner, canonical results, provider node, cheating mode | Dockerfile + runner that returns a stable `result_hash` for 20 tasks |
| C — Chain and verifiers | Contracts, deploys, verifier operators, slashing, Quicknode | Decide Path A vs B; deploy Registry + ServiceManager to testnet |
| D — Coordinator, dashboard, pitch | Coordinator API and DB, scores, dashboard, AgentCore, Ledger flow, demo script, slides | Coordinator skeleton + task generator in `tasks/` |

## 15. Three-minute demo script

The demo has one job: show an agent paying per grade, then catching and refunding a cheater, live on-chain, in three minutes. Rehearse it three times with a timer.

**Setup before going on stage:** three provider nodes running (two honest, one with `--cheat` that returns "all passed" without running tests), three verifiers, the coordinator, the dashboard full-screen, an explorer tab on the trainer's and providers' addresses, sampling at 50%.

1. **0:00–0:25 — The problem.** "Training an AI to code means grading millions of attempts. That grading runs on a few centralized clouds. Ordinary computers could do it, but you can't trust a stranger's grade, and a bad grade quietly poisons the model."
2. **0:25–0:50 — The idea.** "Gradewire lets any computer earn money grading. Grading code is deterministic, so a spot-check re-run is either an exact match or proof of cheating. The training agent pays per grade in RLUSD through Mastercard's AP4M, and the next payment only moves while checks keep passing."
3. **0:50–1:40 — Live run.** Start the trainer. Point at the dashboard: jobs fan out to three providers; each one shows the 402, the voucher, and the payment. Click one `VoucherRedeemed` on the explorer and the provider's RLUSD balance going up. Point at a verification task: three verifiers re-ran it, hashes match, verdict posted on-chain.
4. **1:40–2:30 — The catch.** The cheating node's job gets sampled. Verifiers' hashes don't match its "all passed." Verdict: fail. On screen, in the same few seconds: the trainer stops paying it, its bond is slashed, the trainer's wallet receives the refund (show the explorer), its score drops to zero, and its remaining jobs reroute to honest nodes.
5. **2:30–3:00 — Why it matters.** "Other networks punish cheaters after you've paid. Here, verification decides whether money moves at all, and providers get paid in dollars, not tokens. Built on XRPL EVM with Mastercard AP4M, Quicknode, AgentCore and Ledger."

Have the answer ready for "Isn't this Prime Intellect?": "They proved decentralized RL works and verify GPU rollouts statistically. We handle the grading step, where checks can be exact, and we pay per verified grade in dollars."

## 16. Bounty checklist

Tick these off before submitting; each line is something a judge will look for.

**Agentic Finance track**

- [ ] The trainer agent chooses providers, pays and reroutes with no human in the loop
- [ ] Spending limits are enforced (AP4M channel cap) and visible on the dashboard
- [ ] Main hackathon submission filed with repo link, demo video link and track selected

**Mastercard**

- [x] Registered via Mastercard's form and funded (20 RLUSD, confirmed by email)
- [ ] Merchant wallet registered in the AP4M portal (opens the payment channel)
- [ ] Agent gets a 402, decides to pay, signs and submits the voucher autonomously
- [ ] `VoucherRedeemed` events visible on the XRPL EVM Testnet explorer (links on the dashboard)
- [ ] Merchant payout balance visibly changes in RLUSD
- [ ] Full flow runs live in 3 minutes
- [ ] Goes beyond the starter examples (new merchant type: graders; multi-step agent reasoning: choose, gate, reroute)
- [ ] AP4M project submission form filed

**Quicknode**

- [ ] Joined the Quicknode track in the hackathon app (required for eligibility)
- [ ] XRPL EVM RPC through a Quicknode endpoint
- [ ] A Stream or webhook on `VoucherRedeemed` and `VerdictPosted` drives the dashboard and score updates
- [ ] README explains why Quicknode is essential here, not decorative

**Ledger**

- [ ] Bond withdrawal or trainer budget top-up above a threshold requires a Ledger signature
- [ ] The agent holds a scoped channel budget, never a raw unlimited key
- [ ] Chain ID confirmed with Ledger's booth (their page says 1440000; AP4M uses 1449000)

**AWS**

- [ ] Trainer agent runs on Bedrock AgentCore and calls Gradewire as a paid tool over x402
- [ ] Screenshot or log of the AgentCore run in the README

## 17. Open questions and risks

The biggest risks are AP4M throughput per grade and getting EigenLayer onto XRPL EVM in time; both have a fallback already planned. Ask the booth questions tonight.

### Ask at the booths

- [ ] **Mastercard:** Can a team register multiple merchant payout addresses (one per provider)?
- [ ] **Mastercard:** How long does one voucher redemption take, and what does it cost in gas? Is per-request payment practical at 0.01 RLUSD, or should we batch?
- [ ] **Mastercard:** Are vouchers cumulative within a channel? Who submits redemptions?
- [ ] **Mastercard:** What is RLUSD's contract address on XRPL EVM Testnet, and can a non-AP4M contract (our bond registry) hold and transfer it?
- [ ] **Ledger:** Which chain ID does your signer expect for XRPL EVM, and is there a ready example for signing EIP-712 on a device?
- [ ] **AWS:** Fastest path to an x402-paying agent on AgentCore?
- [ ] **Organizers:** Exact submission cutoff and demo format (live table or stage)?

### Risks and fallbacks

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| Per-grade on-chain payment too slow for a live demo | Medium | Pay per batch of 10 grades |
| EigenLayer contracts won't deploy on XRPL EVM | Medium | Path B standalone contracts by Sunday 9 AM |
| Only one payout address per team | Medium | Coordinator as merchant of record, pays providers onward |
| Sandbox results differ across team laptops (Apple Silicon vs x86) | Medium | Pin a multi-arch image digest and test on both; else run verifiers on the same architecture |
| Venue Wi-Fi drops during the demo | Low–medium | Phone hotspot ready; all services on one machine except one remote provider |
| Testnet congestion or faucet limits | Low | Fund all wallets Saturday night |

### Product questions to settle later (not this weekend)

- Who sets prices: providers, an auction, or the coordinator?
- How to handle environments that need the internet or browsers (non-deterministic): a best-effort tier with probabilistic checks?
- How to protect buyers' proprietary tasks: TEE providers only?

## 18. Glossary and sources

| Term | Meaning here |
| --- | --- |
| RL (reinforcement learning) | Training a model by letting it attempt tasks and rewarding good attempts |
| Rollout | One attempt by the model at one task |
| Reward / grade | The score for a rollout; here, the share of unit tests passed |
| Provider / grader | A machine that runs grading jobs for pay |
| Verifier / operator | A process that re-runs sampled jobs and signs a verdict |
| AVS | EigenLayer "actively validated service": off-chain operators do a task and post signed results on-chain |
| AP4M | Mastercard's agent-payment kit for this hackathon |
| x402 | Pay-per-request over HTTP: unpaid request gets a 402 with terms, the client pays and retries |
| Voucher | A signed payment message an agent issues against its payment channel |
| RLUSD | Ripple's US-dollar stablecoin |
| Bond | Provider's deposit, slashed on a failed check |
| Canary | A job with a known correct answer, used to catch cheaters |
| Quok.it | A Penn senior-design poster (Team 20) on reliability monitoring for decentralized GPU networks; this design's flowchart comes from it. No one on the team built it; credit it as inspiration |

### Sources

- [AP4M Developer Guide](https://hackathon.ap4m.build/integration-guide) (requires portal access for some docs)
- [Hackathon app: prizes and resources](https://hackathons.xrpl-commons.org/hackathons/ai-fintech-xrp-ledger-hackathon-f78ed817?tab=prizes)
- [Luma event page](https://luma.com/xrpl-hackathon-nyc)
- [EigenLayer: How to build an AVS](https://docs.eigenlayer.xyz/developers/how-to-build-an-avs)
- [Prime Intellect: INTELLECT-2 release](https://www.primeintellect.ai/blog/intellect-2-release)
- [Prime Intellect: Protocol and testnet](https://primeintellect.ai/blog/protocol)
- [Lilypad: Validation of GPU computation in decentralized networks](https://arxiv.org/html/2501.05374v1)
- [Hyperbolic: Proof of Sampling deep dive](https://www.hyperbolic.xyz/blog/deep-dive-into-hyperbolic-proof-of-sampling)
- [SemiAnalysis ClusterMAX: Hyperbolic review](https://www.clustermax.ai/cloudreview/hyperbolic)
- [Zylos: RL environments as a service](https://zylos.ai/research/2026-07-15-rl-environments-as-a-service-agentic-training-infrastructure/)
- [Troveo: RL environment companies 2026](https://www.troveo.ai/resources/rl-environment-companies)
- [Kevin Simback on decentralized training](https://x.com/KSimback/status/2074967176726089937)
- [IOSG: RL-driven decentralized AI](https://x.com/IOSGVC/status/2003446318153298020)
- [Modal: sandboxes for the OpenAI Agents SDK](https://modal.com/resources/best-sandbox-openai-agents-sdk)

## 19. Confirmed AP4M facts (from the team's portal kit, ap4m-agent.js, Saturday 7:50 PM)

These supersede the "verify" notes in section 3.

- **The agent opens the Channel itself.** "Waiting for channel" in the portal is normal until `requestChannel()` runs: the agent wallet sends one vault transaction (needs XRP gas), the service binds the merchant payout and opens the Channel. Leave `CHANNEL_ID` empty to open a new one with `CHANNEL_CAP` RLUSD (example default 5).
- **Vouchers are cumulative.** `cumulativeAmount` = total redeemed so far + this payment. Read `redeemed` with `getChannelState()` first.
- **The agent submits redemptions on-chain** via `redeemVoucher()` on the PaymentLedger (needs gas), which emits `VoucherRedeemed`. Then report it with `POST /public/participant/record-redemption`.
- **Settlement releases RLUSD to the merchant payout wallet:** `settle()` returns `settlement_tx`, `payout_tx` and a verifiable `receipt_url`. The service also settles automatically; `settle()` just makes it happen now. Show the receipt URL on the dashboard.
- **Close channels when done:** `closeChannel()` (agent signs a checkpoint).
- **Sign-in:** `signIn(apiUrl, "FranksDAO", agentWallet)` signs a challenge and returns a Bearer token.
- **Network config:** `GET https://hackathon.ap4m.build/public/config` (or `/llms.txt`) gives RPC URL, chain ID and contract addresses. PaymentLedger default: `0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91`.
- **Merchants:** a Channel pays one of the team's own Merchants by default; `listMerchants()` returns other teams' Merchants only if organizers enable cross-team payments. So per-provider payouts likely mean the team's merchant receives and forwards RLUSD to providers (see section 3, "One payout address per team?"), unless the team can register several merchants.
- **Runtime:** Node 22.13+ and `ethers@6.17.0`. The SDK is CommonJS; in an ESM project import it as `ap4m-hackathon-sdk.cjs`.
- **Env names used by the kit:** `AGENT_PRIVATE_KEY`, `TEAM_NAME`, `AP4M_API_URL`, `CHANNEL_ID`, `CHANNEL_CAP`, `PAYMENT_LEDGER`, `AP4M_RPC_URL`.
- **Budget:** 20 RLUSD total. Channel caps reserve budget; each demo payment moves real testnet RLUSD to the team's payout wallet (`0xfef5…`, which the team controls). Keep payments small (0.01–0.1 RLUSD).
