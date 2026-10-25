# Submission text

Use for the main hackathon submission and the Mastercard AP4M form. Track: **Agentic Finance**. Also join the **Quicknode** track in the hackathon app (eligibility requirement).

## One-liner

Gradewire: verified pay-per-job compute for AI agents. An agent on your laptop farms deterministic programs out to anyone's computer, pays per job in RLUSD over HTTP 402 with Mastercard AP4M, and independent verifiers re-run a sample on-chain; the agent never pays for a result that hasn't held up.

## Description (about 170 words)

An AI agent that needs compute it can trust has one option today: a centralized cloud, because nobody can tell whether a stranger's computer actually ran the job. Gradewire lets any computer sell compute to agents, one job at a time. The agent takes your question, writes small deterministic Python programs and sends each to a different node. Nodes sell the run over HTTP 402 using Mastercard's AP4M kit: the agent signs a Voucher locally, the node redeems it on the XRPL EVM PaymentLedger, and RLUSD settles to the merchant payout wallet. The sandbox is deterministic (pinned image digest, no network, fixed environment, output only), so a verifier's re-run either matches the result hash exactly or proves cheating. Sampled jobs become on-chain verification tasks; a 2-of-3 verifier quorum posts the verdict. A failed verdict slashes the node's bond in the same transaction, half of it refunding the agent, which stops paying that node and reroutes the job. The agent answers only from verified outputs. The same network grades RL rollouts as a batch workload. Only a sample is re-run, and only deterministic CPU work can be checked this way.

## Mastercard criteria, point by point

- **Autonomy:** the agent decides what to compute (it writes the programs), which nodes to send them to (price ÷ score, `--max-price 0.01`, `--min-score 0.8`), receives each 402, signs and submits the Voucher, gates its use of a result on the on-chain verdict, bans a node on a failed verdict and reroutes the job, all with no human in the loop.
- **Use case clarity:** no payment, no result. The node computes the output only after the redemption is confirmed on-chain, and the agent cannot answer without the outputs.
- **On-chain proof:** every job has its own `VoucherRedeemed` event; links on the dashboard and in the README "Proof" table.
- **RLUSD settlement:** the agent calls `settle` per Channel at the end of a run (skipped with `--no-settle` on stage for time) and prints the payout transaction and receipt URL; the payout wallet balance grows.
- **Demo quality:** `docs/DEMO.md`, three minutes, all live.
- **Creativity:** the merchant sells arbitrary verified computation to an LLM agent (per-job paid resources instead of one fixed `/resource`), multi-step agent reasoning (decompose, choose, pay, verify, gate, ban, reroute, compose), and payments whose continuation depends on independent on-chain verification.

## Links

- Repo: (fill in)
- Demo video (backup for the README only; the judged demo is live): (fill in)
- Contracts: `deployments/testnet.json`; proof transactions in README "Proof".
- Dashboard: runs locally at http://127.0.0.1:4500/ (take a screenshot during a rehearsal and add it to the README).

## Bounty checklist (from the brief, section 16)

**Agentic Finance**
- [x] Agent chooses nodes, pays and reroutes with no human in the loop (exercised with the RL trainer workload)
- [x] Trust earned per verified job: the agent lets a node hold only as many unverified paid jobs as its clean checks allow (1 for a new node, +1 per clean check, max 3); sampling drops to 50 % after 3 clean checks; a failed check suspends the node and the agent discards and reroutes its unverified results. Shown per node on the dashboard ("Trust earned" column and feed lines)
- [x] Usable by any agent: MCP server (`packages/mcp/server.mjs`, `.mcp.json`) with `gradewire_run` / `gradewire_nodes` / `gradewire_status`; exercised from a real MCP client and from Claude Code
- [x] Spending limits enforced: one capped AP4M Channel per node (`CHANNEL_CAP`, default 0.5 RLUSD); the agent reports every Channel's cap and spend to the coordinator and the dashboard's **Agent budget** panel shows cap, spent, remaining and status per node live (`POST /agent/budget`, SSE `budget`).
- [ ] Rehearse the ask demo 3 times (`scripts/ask.sh ... --parts 3 --no-settle`, with the cheater caught and the answer composed from verified outputs)
- [ ] `claude` CLI logged in on the demo laptop (or `ANTHROPIC_API_KEY` set) and a `--dry-run` passes before going on stage
- [ ] Main submission filed with repo link, demo video link, track selected

**Mastercard**
- [x] Registered and funded (20 RLUSD)
- [x] Merchant wallet registered in the portal
- [x] Agent gets a 402, decides to pay, signs and submits the Voucher autonomously
- [x] `VoucherRedeemed` events on the explorer (dashboard links)
- [x] Merchant payout balance changes in RLUSD (settle receipts)
- [ ] Full flow live in 3 minutes (rehearse 3 times with the ask flow)
- [x] Beyond the starter examples (merchant sells arbitrary verified computation to an LLM agent; decompose/choose/gate/reroute)
- [ ] AP4M project submission form filed

**Quicknode**
- [ ] Joined the Quicknode track in the hackathon app
- [x] `QUICKNODE_RPC_URL` set: XRPL EVM Testnet endpoint, chain 1449000 confirmed, all processes read the chain through it (`makeProvider` chunks `eth_getLogs` to the Discover plan's 5-block limit)
- [x] Streams webhook implemented on the coordinator (`POST /webhooks/quicknode`, same handler as the local watcher, feeds the dashboard and scores; `WATCH_CHAIN=0` makes the Stream the only event source); self-tested with real chain logs via `scripts/test-quicknode-webhook.mjs` (secret enforced, duplicates ignored, nested payloads unwrapped). Runbook: `docs/QUICKNODE.md`; tunnel: `scripts/tunnel.sh`
- [ ] Stream created in the Quicknode console against the tunnel URL and exercised
- [x] README explains why it matters (verdict latency gates payments)

**Ledger**
- [x] Bond withdrawal requires an approver EIP-712 signature checked on-chain; wrong signer and replay refused on testnet (software approver key)
- [x] The agent holds capped Channel budgets, never a raw unlimited key
- [x] Device signing implemented: `scripts/approve-withdraw.mjs --ledger` (official `@ledgerhq/hw-app-eth`, EIP-712 with hashed fallback, local verification, approver check); runbook `docs/LEDGER.md`
- [ ] Sign the approval on a physical Ledger (needs a device); chain ID confirmed with Ledger's booth

**AWS**
- [x] AgentCore runtime app updated to the ask flow (`{"question","parts"}` → paid verified compute; RL path kept) with a README for the current `agentcore` CLI; local dry run passes
- [ ] Deployed on Bedrock AgentCore (needs AWS credentials and `ANTHROPIC_API_KEY` in the runtime; no `claude` CLI in the container)

## Honest limits to state if asked

Only a sample is re-run (100 % of a node's first three verified jobs, then 50 % in the demo). GPU work is out of scope: it is not bit-reproducible, so an exact re-run cannot check it; only deterministic CPU jobs can. The LLM is not verified and does not run on the network: it runs on the laptop and only writes the programs. Decentralized compute, marketplaces and agent payments are not new; the new part is exact verification gating each payment, settled in RLUSD on XRPL. Prime Intellect proved decentralized RL works; Gradewire does not train anything. Demo bonds and prices are 0.01 RLUSD because of the testnet budget. EigenLayer core contracts were not deployed (standalone AVS-pattern contracts with the same events). The proof transactions in the README were produced by the RL trainer workload; the ask agent runs through the same engine and still needs its stage rehearsals. The Quicknode Stream, Ledger device signing and AgentCore deployment are implemented in code but were not exercised against those services.
