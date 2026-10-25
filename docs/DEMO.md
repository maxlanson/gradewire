# Three-minute live demo

Everything on stage is live on XRPL EVM Testnet. Nothing is pre-recorded or mocked.

## Before going on stage (10 minutes)

```bash
# 1. gas + bonds for the three grader identities (idempotent)
node --env-file=.env scripts/fund-nodes.mjs 4401 4402 4403

# 2. a clean cheater identity each run (a slashed identity stays suspended on-chain)
rm -rf .state/node-4403 && node --env-file=.env scripts/fund-nodes.mjs 4403

# 3. start coordinator, 3 verifiers, Grader A + B (honest), Grader C (--cheat)
scripts/demo-up.sh
open http://127.0.0.1:4500/            # dashboard, full screen
tail -f .state/logs/*.log              # second screen, optional
```

Wait until the dashboard shows three graders **active** with a 0.01 RLUSD bond each (about 40 s).
Open explorer tabs on the trainer wallet and the team payout wallet.

Phone hotspot ready. If the venue Wi-Fi drops, the only external dependencies are the XRPL EVM RPC and the AP4M service.

## On stage

**0:00 The problem (20 s).** "Training an AI to code means grading millions of attempts. That grading runs on a few centralized clouds. Ordinary computers could do it, but nobody can trust a stranger's grade, and a wrong grade quietly poisons the model."

**0:20 The idea (25 s).** "Gradewire lets any computer earn money grading. Grading code is deterministic, so a spot-check re-run is either an exact match or proof of cheating. The training agent pays per grade in RLUSD through Mastercard's AP4M, and the next payment only moves while checks keep passing."

**0:45 Run it (60 s).** In the terminal:

```bash
CHANNEL_ID=<open channel id> scripts/trainer.sh --jobs 9
```

Point at the dashboard while it runs:
- jobs fan out to three graders; each line in the terminal is a 402, a signed voucher, a redemption;
- click one **VoucherRedeemed** link: the Mastercard PaymentLedger event on the explorer;
- the **Verification tasks** panel: three verifiers re-ran a job, hashes match, verdict posted on-chain;
- the verdict is also anchored as a memo on the native XRP Ledger (XRPL link).

**1:45 The catch (50 s).** Grader C returns "all tests passed" without running anything. Its first sampled job may be a rollout where that is actually right (the verifiers reproduce it, pass). On the first buggy rollout the verifiers' hashes differ: **verdict FAIL**. In the same block:
- the trainer prints `✗ ... FAILED verification ... Stopping all payments to Grader C` and reroutes the job;
- the **Slashed** event: bond split 50 % refund to the trainer, 30 % to the two verifiers that caught it, 20 % treasury;
- the trainer's RLUSD balance ticks up on the explorer (the refund);
- Grader C's score drops to 0 and its status to **suspended**; it can never re-register with that key.

**2:35 Why it matters (25 s).** "Other networks punish cheaters after you've paid. Here verification decides whether money moves at all, and graders are paid in dollars, not tokens. Built on XRPL EVM with Mastercard AP4M, verdicts anchored on the XRP Ledger, bonds released only with a hardware-wallet approval."

## Questions we expect

- *Isn't this Prime Intellect?* They proved decentralized RL works and verify GPU rollouts statistically. We handle the grading step, where checks can be exact, and pay per verified grade in dollars.
- *Only a sample is verified?* Yes. New providers are checked 100 % for their first three jobs, then 50 % in the demo (5 % for trusted providers in production). A cheater's expected gain before being caught is far below the bond.
- *Why is the bond so small?* 0.01 RLUSD because the team budget is 20 RLUSD of testnet funds; the contract takes any size.
- *What if an honest node's result differs?* The sandbox is pinned by image digest with no network, fixed env, and a runner that records only pass/fail, so results are bit-identical across machines; we ran 20 rollouts twice on this machine and across node restarts with identical hashes.

## Reset between rehearsals

```bash
scripts/demo-down.sh
rm -rf .state/coordinator .state/node-4403 .state/trainer/inflight-*.json
node --env-file=.env scripts/fund-nodes.mjs 4403
```

Keep `.state/node-4401` and `.state/node-4402`: those identities are already attested and bonded.
