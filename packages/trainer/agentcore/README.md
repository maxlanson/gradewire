# Gradewire on Amazon Bedrock AgentCore

Status: **code ready, not deployed** (no AWS credentials at the table). `agentcore_app.py` is an
AgentCore Runtime entrypoint that exposes Gradewire as the agent's paid tools:

| Payload | Tool | What runs |
|---|---|---|
| `{"question": "How many primes are below 10 million?", "parts": 3}` | `gradewire.ask` | the ask agent (`scripts/ask.sh` → `packages/ask/index.mjs`): Claude plans up to `parts` deterministic Python programs, each is paid to an untrusted node over Mastercard AP4M x402 (RLUSD, XRPL EVM Testnet), the coordinator samples them, three verifiers re-run them and post a verdict on-chain; the answer is composed only from verified output. Returns `answer`, `payments` (one `VoucherRedeemed` link per job), `verdicts`, `fraud` (slash/reroute lines), `settlement` and the one-line `summary` ("paid … RLUSD over AP4M x402 · … verified on-chain · … caught cheating · refunds received …"). Optional keys: `max_price`, `min_score`, `no_settle` (default true), `plan_only` (plan, pay nobody), `node`, `coordinator`. |
| `{"jobs": 4}` | `gradewire.grade_rollouts` | the RL workload (`packages/trainer/index.mjs`): same engine, same payments; returns accepted grades and fraud events. |

The runtime itself does no compute: the model call and the payments happen in the container, the
programs run on the nodes. **The container needs `ANTHROPIC_API_KEY`**: there is no `claude` CLI
inside it, so the ask agent takes its Anthropic SDK path (`ASK_MODEL`, default `claude-sonnet-5-5`).
The handler invokes `node --env-file-if-exists=.env packages/ask/index.mjs …` with the same
arguments `scripts/ask.sh` passes, so it works on the laptop (with `.env`) and in the container
(variables from the runtime environment) alike.

Local dry run without the SDK or AWS (checks the handler and prints the commands it would run):

```bash
python3 packages/trainer/agentcore/agentcore_app.py
```

## What the docs say (confirmed Oct 24 2026)

- The Python **starter toolkit is deprecated**: its README says "DEPRECATED — Do not use this
  toolkit. Use the AgentCore CLI instead" and "The Starter Toolkit CLI is no longer supported"
  (github.com/aws/bedrock-agentcore-starter-toolkit). The `agentcore configure -e … / launch /
  invoke` flow from the earlier version of this README is gone; the new tool is the npm
  **AgentCore CLI**: `npm install -g @aws/agentcore` (Node 20.12+, AWS credentials as for the AWS
  CLI, Python 3.10+ and `uv` for Python runtimes). Source:
  docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-get-started-cli.html.
- Entrypoint contract (SDK source `src/bedrock_agentcore/runtime/app.py` in
  github.com/aws/bedrock-agentcore-sdk-python): `BedrockAgentCoreApp` is a Starlette app;
  `@app.entrypoint` registers one handler called as `handler(payload)` or
  `handler(payload, context)` (the second parameter must be named `context`; it carries
  `session_id` and filtered request headers); a dict/str return is sent as `application/json`, a
  generator or async generator is streamed as SSE; `app.run(port=8080)` serves
  `POST /invocations`, `GET /ping` and `/ws`, binding all interfaces inside a container. The README
  imports `from bedrock_agentcore import BedrockAgentCoreApp`; `bedrock_agentcore.runtime` is the
  module that defines it and works too.
- Service contract (devguide `runtime-http-protocol-contract.html`): host `0.0.0.0`, port `8080`,
  **ARM64** container, `POST /invocations` with a JSON body → JSON or `text/event-stream`,
  `GET /ping` → `{"status": "Healthy" | "HealthyBusy"}` (the SDK answers it for you). Errors from
  the container surface as HTTP 424 `RuntimeClientError`.
- CLI commands (devguide + github.com/aws/agentcore-cli `command.md`): `agentcore create --name X
  --template agent-python-strands[-container]`, `agentcore add runtime --name <n> --language python
  --protocol HTTP [--environment-variables '{"KEY":"value"}']`, `agentcore dev [--agent <n>]
  [--mode browser] [--port]`, `agentcore build`, `agentcore deploy [--target]`, `agentcore status`,
  `agentcore invoke --runtime <n> --payload '{…}' [--session-id] [--local --port 8080]`,
  `agentcore logs runtime --name <n> --tail`. Placing a `Dockerfile` in the runtime's folder
  switches it from a `CodeZip` build to a container build; **cloud container builds run in AWS
  CodeBuild**, so no local Docker is needed except for `agentcore dev` on a container runtime.
- Environment variables for a deployed runtime: `agentcore add runtime --environment-variables
  '<json object>'` (CLI), or `this.application.runtime('<n>').addEnvironmentVariable('KEY',
  value)` in `agentcore/cdk/lib/cdk-stack.ts` (devguide `customize-project-cdk-code.html`). Model
  API keys chosen in the create wizard are stored in `agentcore/.env.local` and provisioned as
  AgentCore Identity credentials. Where `--environment-variables` values are persisted (probably
  `agentcore/agentcore.json`) was not verified: check before committing anything from the project
  directory, and never put `AGENT_PRIVATE_KEY` in a committed file.
- AWS also ships **AgentCore Payments** (devguide `payments.html`): x402/MPP microtransactions
  with Coinbase CDP or Stripe/Privy stablecoin wallets and per-session spend limits. It does not
  speak Mastercard AP4M or settle RLUSD on XRPL EVM, so Gradewire keeps its own AP4M client; the
  pitch is "an AgentCore-hosted agent paying x402 merchants on XRPL", not AgentCore Payments.

## Deploy (for whoever has the AWS account; about 30 minutes, us-east-1 or any AgentCore region)

1. Make the Gradewire services reachable from AWS. Every service listens on `127.0.0.1`, so on the
   demo laptop run one tunnel per public port (each prints its `https://…trycloudflare.com` URL):

   ```bash
   scripts/tunnel.sh 4500      # coordinator  -> COORDINATOR_URL for the runtime
   scripts/tunnel.sh 4401      # node A       -> start the node with NODE_PUBLIC_URL=<that URL>
   scripts/tunnel.sh 4402      # node B
   scripts/tunnel.sh 4403      # node C (the cheater)
   ```

   Nodes advertise `NODE_PUBLIC_URL` to the coordinator and on-chain and embed it in their x402
   resource URLs (`packages/node/server.mjs`), so set it **before** the nodes start
   (`NODE_PUBLIC_URL=https://… scripts/node.sh --port 4401 --label "Node A"` per node, instead of
   `scripts/demo-up.sh`). Simplest demo-day setup: the whole stack on one laptop, four
   `cloudflared` quick tunnels (no account; the URLs change on restart, so start them first and
   keep the terminals open), the AgentCore runtime as the paying agent. A single reverse proxy on
   one hostname would also work but needs path rewriting the nodes do not do; four tunnels is less
   to debug. Everything else (verifiers, dashboard) stays local.

2. Create the CLI project next to the repo and add Gradewire as a container runtime:

   ```bash
   npm install -g @aws/agentcore
   agentcore create --name gradewire-agentcore --template agent-python-strands   # any template; we add our own runtime
   cd gradewire-agentcore
   agentcore add runtime --name gradewire --language python --protocol HTTP \
     --environment-variables '{"COORDINATOR_URL":"https://<coordinator tunnel>","AP4M_API_URL":"https://hackathon.ap4m.build","TEAM_NAME":"FranksDAO","ASK_MODEL":"claude-sonnet-5-5","CHANNEL_CAP":"0.5"}'
   rsync -a --exclude node_modules --exclude .state --exclude .env ../gradewire/ app/gradewire/gradewire/
   ```

   Add `ANTHROPIC_API_KEY`, `AGENT_PRIVATE_KEY` and `AGENT_ADDRESS` the same way (or through
   `addEnvironmentVariable` in the CDK stack, reading from an SSM parameter if time allows); they
   are secrets, never commit them.

3. `app/gradewire/Dockerfile` (ARM64; a Dockerfile makes the CLI build a container in CodeBuild):

   ```Dockerfile
   FROM --platform=linux/arm64 node:24-bookworm-slim
   RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
     && rm -rf /var/lib/apt/lists/* && pip3 install --break-system-packages bedrock-agentcore
   WORKDIR /app/gradewire
   COPY gradewire/ ./
   RUN npm ci --omit=dev
   ENV GRADEWIRE_REPO=/app/gradewire
   EXPOSE 8080
   CMD ["python3", "packages/trainer/agentcore/agentcore_app.py"]
   ```

   The image needs Node 24 (the ask agent and the AP4M SDK are JavaScript) and Python 3.10+ for the
   entrypoint; it does **not** need Docker, because grading happens on the nodes.

4. Build, deploy, invoke:

   ```bash
   agentcore build
   agentcore deploy
   agentcore status
   agentcore invoke --runtime gradewire --payload '{"question":"How many primes are below 10 million, and what is the 100,000th prime?","parts":3}'
   agentcore invoke --runtime gradewire --payload '{"jobs":4}'
   agentcore logs runtime --name gradewire --tail
   ```

   Local check before deploying: `agentcore dev --agent gradewire`, then
   `agentcore invoke --runtime gradewire --local --payload '{"question":"What is the 1000th prime?","parts":1,"plan_only":true}'`
   (`plan_only` plans with Claude but pays nobody).

5. Paste the invoke output (it contains the `VoucherRedeemed` and verdict explorer links) and a
   screenshot of `agentcore status` into the top-level README under "AWS Bedrock AgentCore" and
   update its Status line.

If the npm CLI cannot be installed, the deprecated Python toolkit still accepts
`pip install bedrock-agentcore-starter-toolkit`, `agentcore configure -e agentcore_app.py`,
`agentcore launch`, `agentcore invoke '{"question":"…","parts":3}'` with the same Dockerfile; AWS
marks it unsupported.

## Not verified

Nothing above ran on AWS. Unverified: the maximum synchronous invocation duration (an ask run takes
one to three minutes; if the limit is shorter, turn the handler into a generator so the response
streams as SSE), where the CLI persists `--environment-variables`, and whether CodeBuild accepts the
`--platform` line in the Dockerfile (drop it if the build complains; the runtime is ARM64 anyway).
