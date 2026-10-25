# Run a Gradewire node on your laptop (demo day)

One command joins your laptop to the network as a paid node. The agent on the team laptop
will pick it like any other node, pay it per job in RLUSD over AP4M x402, and the three
verifiers will re-run a sample of its jobs. No keys or secrets are needed on your machine.

## You need

- A Mac (Apple Silicon is what the verifiers run on) with **Docker Desktop** running
- **Node.js 22.13+** (`brew install node`) and **cloudflared** (`brew install cloudflared`)
- The coordinator's current tunnel URL from whoever runs the team laptop (it changes
  whenever that tunnel restarts)

## Join

```bash
git clone https://github.com/maxlanson/gradewire && cd gradewire
scripts/join.sh --coordinator https://<team-laptop-tunnel>.trycloudflare.com --label "Node Sam"
```

The script checks the tools, installs packages, pulls the pinned sandbox image, opens an HTTPS
tunnel to your node, starts it and prints:

```
[node] waiting for funding of 0xYOURNODE...: needs 3 XRP for gas and 0.01 RLUSD for the bond
```

Send that address to the team laptop. Once it is funded (about 30 s) the node registers
on-chain, passes the benchmark, posts its bond and appears in the dashboard's Nodes table as
"active" with trust "1 at a time · all re-run". Leave the terminal open; Ctrl-C stops the node
and its tunnel. Running the command again reuses the same key and funding.

Flags: `--port 4411` (default), `--price 0.01` (RLUSD per job), `--cheat` (return fabricated
output without running the job, to be caught on stage).

## On the team laptop

```bash
scripts/tunnel.sh 4500                       # once; share the printed URL with joiners
node --env-file=.env scripts/fund-nodes.mjs --address 0xYOURNODE...   # per joiner, as addresses arrive
scripts/ask.sh "..." --parts 3 --no-settle   # the agent now spreads jobs over all active nodes
```

Each joiner costs 3 XRP (agent wallet) and 0.01 RLUSD bond (payout wallet).

## Verified Oct 25

Tested from the team laptop itself with both tunnels in place: `scripts/join.sh` against the
coordinator's tunnel, funding by address, on-chain registration, benchmark, bond, then one paid
job over the node's HTTPS tunnel via `scripts/ask.sh --node https://...trycloudflare.com`.

## What can go wrong

- *cannot reach the coordinator*: the tunnel URL changed, or your DNS has not learned the new
  hostname yet (new trycloudflare names take up to a minute to resolve on some networks).
- *Docker is installed but not running*: start Docker Desktop.
- Intel Macs or Linux x86: the sandbox image is pinned by digest and the jobs are integer
  arithmetic, so hashes are expected to match the Apple Silicon verifiers, but this was not
  tested during the hackathon. A mismatch would show as a failed verdict and a slashed bond, so
  prefer Apple Silicon laptops for the stage demo.
