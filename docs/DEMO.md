# Three-minute live demo

Everything on stage is live on XRPL EVM Testnet. Nothing is pre-recorded or mocked.

## Before going on stage (10 minutes)

```bash
# 1. gas + 0.01 RLUSD bond for the three node identities (idempotent)
node --env-file=.env scripts/fund-nodes.mjs 4401 4402 4403

# 2. a clean cheater identity each run (a slashed identity stays suspended on-chain)
rm -rf .state/node-4403 && node --env-file=.env scripts/fund-nodes.mjs 4403

# 3. start coordinator, 3 verifiers, Node A + B (honest), Node C (--cheat)
scripts/demo-up.sh
open http://127.0.0.1:4500/            # dashboard, full screen
tail -f .state/logs/*.log              # second screen, optional
```

Wait until the dashboard shows three nodes **active** with a 0.01 RLUSD bond each (about 40 s).

The agent uses the local `claude` CLI on the demo laptop (logged in); no API key is needed. Setting `ANTHROPIC_API_KEY` in `.env` switches it to the Anthropic SDK. Run `scripts/ask.sh "..." --dry-run` once before going on stage to confirm the model answers and the programs look right; a dry run pays nobody.

AP4M allows **three open Channels per payout**. The agent keeps one Channel per node (`.state/trainer/channels.json`), hands a banned node's Channel to the next new identity, and only opens a new one when none is free, so do not open Channels by hand before the demo. Check with `node --env-file=.env scripts/channels.mjs`; if a run ever ends with a node unfunded, close a Channel with `node --env-file=.env scripts/channels.mjs close 0x…` or run the agent again (it closes a banned node's Channel at the end).

Open explorer tabs on the agent wallet and the team payout wallet.

Phone hotspot ready. If the venue Wi-Fi drops, the external dependencies are the XRPL EVM RPC, the AP4M service, the Anthropic API and the XRPL Testnet websocket (verdict anchoring; a failed anchor is logged and does not block anything). The sandbox image is already pulled, so running the jobs themselves needs no network.

## Demo day with outside laptops (order matters)

The agent can fund at most **three AP4M Channels per run**, so a run uses at most three nodes. For the stage: Node A (honest, this laptop), Node C (cheater, this laptop) and one teammate's laptop (honest, closes the lid for the unreliable beat). Do the steps in this order; a coordinator reset after teammates have joined forgets them and they must join again.

```bash
# 1. reset and start, without Node B (its slot goes to the teammate)
scripts/demo-down.sh; rm -rf .state/coordinator .state/node-4403; find .state/trainer -name 'inflight-*.json' -delete
node --env-file=.env scripts/fund-nodes.mjs 4403
NODES="A C" scripts/demo-up.sh

# 2. expose the coordinator and share the URL (new tunnel names take ~30 s to resolve on some networks)
scripts/tunnel.sh 4500          # keep this terminal open for the whole demo

# 3. teammate, on their laptop (see docs/JOIN.md):
#    git clone https://github.com/maxlanson/gradewire && cd gradewire
#    scripts/join.sh --coordinator https://<url from step 2> --label "Node Sam"
#    -> they read out the 0x address their panel shows

# 4. fund it (3 XRP from the agent wallet, 0.01 RLUSD bond from the payout wallet)
node --env-file=.env scripts/fund-nodes.mjs --address 0x<their address>

# 5. wait until the dashboard shows Node A, Node C and their node active, then dry-run once
scripts/ask.sh "How many primes are below 10 million, and what is the 100,000th prime?" --parts 3 --dry-run
```

**Three teammate laptops, no local nodes:** `NODES="" scripts/demo-up.sh` starts only the coordinator and verifiers; one teammate joins with `--cheat` (they are slashed on stage and must `rm -rf .state/node-4411` and re-join before the next run), one closes the lid, one stays honest. Joined laptops use the public RPC, not the Quicknode key, so they add no rate-limit load.

On stage, run the same question with `--parts 3` (one part per node). Cue the teammate to close the lid when the dashboard's feed shows their node "ran …" or their panel says "running"; the window is the 15-25 s a job takes. After the run, their laptop reopened shows "back online" in the feed.

Gotchas:
- **Tunnel URL changed** (you restarted `scripts/tunnel.sh`): teammates re-run the join command with the new URL; their key and funding are reused.
- **Coordinator reset** (`rm -rf .state/coordinator`): teammates must re-run the join (the node re-registers; no new funding).
- **A teammate ran `--cheat` and got slashed**: that key is suspended on-chain for good. They `rm -rf .state/node-4411` and re-run the join; you fund the new address.
- **More than three eligible nodes**: the agent funds Channels in the coordinator's ranking order and prints `cannot fund <node>` for the rest; stop a local node (`NODES="A C"`) rather than relying on the ranking.
- **Quicknode's 15 requests/s** is shared by every process including joined nodes; one or two joiners is fine, a room full is not.

## Demo on three VMs on this laptop (no teammates needed)

Three Lima VMs (Ubuntu, Docker, arm64 like the verifiers), each a separate machine with its own key and node, reachable through Lima's localhost port forwarding. Roles: A honest, B honest but "unreliable" (its VM is stopped mid-job), C cheater.

```bash
brew install lima                                   # once
scripts/demo-down.sh; rm -rf .state/coordinator; find .state/trainer -name 'inflight-*.json' -delete
NODES="" scripts/demo-up.sh                         # coordinator + verifiers only
scripts/tunnel.sh 4500                              # own terminal; the VMs reach the coordinator through it
U=$(cat .state/tunnel-4500.url)
scripts/vm-node.sh node-a 4421 --coordinator "$U" --label "Node A (vm)"            # creates + provisions the VM the first time (~5 min), then ~20 s
scripts/vm-node.sh node-b 4422 --coordinator "$U" --label "Node B (vm)"
scripts/vm-node.sh node-c 4423 --coordinator "$U" --label "Node C (vm)" --cheat
node --env-file=.env scripts/fund-nodes.mjs --address 0x… --address 0x… --address 0x…   # the three addresses the scripts print (first time only)
scripts/demo-windows.sh "A http://127.0.0.1:4421 honest" "B http://127.0.0.1:4422 unreliable" "C http://127.0.0.1:4423 cheater"   # three small panel windows
```

On stage, after the parts are dispatched and Node B (vm) shows "running" in its panel: `limactl stop node-b` (the lid closes). The agent reroutes within seconds, the dashboard flags it offline after 20 s, its panel goes red. Bring it back with `limactl start node-b && scripts/vm-node.sh node-b 4422 --coordinator "$U" --label "Node B (vm)"`.

After a slash the cheater's key is burned: `limactl shell node-c -- rm -rf ~/gradewire/.state/node-4423`, re-run its `vm-node.sh` line and fund the new address. A coordinator reset forgets the VM nodes; re-run the three `vm-node.sh` lines (no new funding).

## On stage

**0:00 The problem (20 s).** "An AI agent on your laptop needs compute it can trust. Today that means a centralized cloud, because if you hand a job to a stranger's computer you have no way to know whether it actually ran it. And an agent that acts on a made-up result does damage quietly."

**0:20 The idea (25 s).** "Gradewire lets any computer sell compute to an agent, one job at a time. The agent writes small deterministic programs, nodes run them in a locked-down sandbox and sell the run over HTTP 402 with Mastercard's AP4M, in RLUSD. Because the sandbox is deterministic, a spot-check re-run by independent verifiers is either an exact match or proof of cheating. The agent never pays for a result that hasn't held up: verification decides whether money moves at all."

**0:45 Run it (60 s).** In the terminal:

```bash
scripts/ask.sh "How many primes are below 10 million, and what is the 100,000th prime?" --parts 3 --no-settle
```

Narrate while it runs:
- the agent prints the three programs Claude wrote (the model runs here on the laptop; it only writes the code) and sends each to a different node in parallel;
- per job in the terminal: the 402 with the price, the Voucher signed locally, the redemption, 0.01 RLUSD each; click one **tx** link in the Paid column of the Jobs panel: the Mastercard PaymentLedger event on the explorer;
- the Jobs panel's **Checked by 3 verifiers** column: a sampled job's three squares turn green as verifiers re-run it, then "verified" with the verdict link; the same steps scroll past in the What's happening feed;
- the feed line "anchored the verdict on the XRP Ledger": the same verdict as a memo on the native XRP Ledger (XRPL link).

**1:45 The catch (50 s).** Meanwhile the honest nodes have earned trust: after their first clean check the feed says "earned trust: 2 jobs at a time" and the Trust column moves, so the agent lets them hold more work. Node C returned a fabricated output without running anything. A new node's every job is re-run, so its first job is checked: the verifiers' hashes do not match its result: **verdict FAIL**. In the same transaction:
- the agent prints `✗ ... FAILED verification ... Stopping all payments to Node C` and resends that job to an honest node;
- the feed line "bond slashed": 50 % refunded to the agent, 30 % to the verifiers that caught it, 20 % treasury;
- the agent's RLUSD balance ticks up on the explorer (the refund; the agent also prints the before/after balance at the end);
- Node C's score drops to 0 and its status to **suspended**; it can never re-register with that key.

**The unreliable node (optional, 20 s, needs a teammate's laptop joined via `scripts/join.sh`).** While the parts are running, the teammate closes their laptop. Within seconds the agent prints `[reroute] part-N leaves Node <name> (node unreachable)` and an honest node picks the part up; about 20 s later the feed shows "went offline: no heartbeat … its jobs are rerouted, reliability drops, no slash" and the node's row turns **offline**. Say it out loud: a dead node is a health failure, not fraud. It is not slashed, it is simply not paid for work it did not finish and it stops being offered work until it is back and its reliability recovers. Opening the laptop again shows "back online".

Then the last verdict lands and the agent prints the answer, composed only from the verified outputs: the prime count and the 100,000th prime, with the node and verdict for each part.

**Optional: another agent buys compute (30 s, if time allows).** In a second terminal, Claude Code with the repo's `.mcp.json`:

```bash
claude -p "Use the gradewire tools: check which nodes are online, then run a Python program on the network that prints the 10,000th prime, and tell me the verified answer with its payment and verdict links." --mcp-config .mcp.json --allowedTools "mcp__gradewire__*"
```

Claude writes the program itself, calls `gradewire_run`, the dashboard shows the 402, the payment and the verdict, and Claude answers with the explorer links. Say: "any agent that speaks MCP can buy verified compute here; it never touches a key or a Voucher."

**2:35 Why it matters (25 s).** "Other networks punish cheaters after you've paid. Here verification decides whether money moves at all, and nodes are paid in dollars, not tokens. The same network grades reinforcement-learning rollouts as a batch workload. Built on XRPL EVM with Mastercard AP4M, verdicts anchored on the XRP Ledger, bonds released only with an approver's signature."

Backup if the model or the Anthropic API is unreachable: `scripts/trainer.sh --jobs 9` runs the RL grading workload through the same nodes, payments, verification and catch, with no LLM in the loop.

## Questions we expect

- *Isn't this Prime Intellect?* They proved decentralized RL works and verify GPU rollouts statistically. We sell exactly checkable CPU jobs to agents and pay per verified job in dollars; the RL grading step is one workload of that. We do not train anything and we do not run models on the network.
- *Why not just run it locally?* The demo question is small on purpose so it fits in three minutes. The point is the market: any computer can sell compute, and the buyer can trust the result without trusting the seller. That is what lets an agent farm out work it cannot or should not run itself.
- *Isn't an LLM non-deterministic?* Yes, and it is not part of what is verified. The model runs on the laptop and only writes the programs. What the nodes run, and what the verifiers re-run, is the deterministic program; its output hash is what is checked.
- *Only a sample is verified?* Yes. A node's first three verified jobs are checked 100 %, then 50 % in the demo (`SAMPLING_RATE`); the design target for trusted nodes is 5 %. A cheater's expected gain before being caught is far below the bond.
- *Why is the bond so small?* 0.01 RLUSD because the team budget is 20 RLUSD of testnet funds; the contract takes any size.
- *What if an honest node's result differs?* The sandbox is pinned by image digest with no network, fixed env, and a runner that records only the program's output or pass/fail, so results are bit-identical across machines; we ran the 20 RL rollouts twice on this machine and across node restarts with identical hashes.
- *Does this work for GPU inference?* No. GPU results are not bit-reproducible, so an exact re-run cannot check them. Gradewire is for deterministic CPU jobs only.

## Reset between rehearsals

```bash
scripts/demo-down.sh
rm -rf .state/coordinator .state/node-4403
find .state/trainer -name 'inflight-*.json' -delete   # not a glob: zsh aborts the whole rm line when no inflight file exists
node --env-file=.env scripts/fund-nodes.mjs 4403
```

Keep `.state/node-4401` and `.state/node-4402`: those identities are already attested and bonded. Keep `.state/trainer/channels.json`: it is how the agent reuses its three Channels.
