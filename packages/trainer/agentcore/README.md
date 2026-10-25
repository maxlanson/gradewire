# Trainer on Bedrock AgentCore (scaffold)

Status: scaffold only, not deployed. Nobody at the table had AWS credentials during the build. `agentcore_app.py` follows the AgentCore Runtime contract (one `@app.entrypoint` handler) and exposes Gradewire as the agent's paid tool `gradewire.grade_rollouts`: the handler runs `node --env-file=.env packages/trainer/index.mjs --jobs <n> [--coordinator <url>]`, which does the x402 payments autonomously, and returns the accepted grades, fraud events and summary lines.

Steps for whoever has an AWS account (us-east-1 or another AgentCore region):

```bash
pip install bedrock-agentcore bedrock-agentcore-starter-toolkit
cd packages/trainer/agentcore
agentcore configure -e agentcore_app.py        # creates the runtime config + Dockerfile
# The container needs Node 22.13+, the repo (or GRADEWIRE_REPO pointing at it), and the
# .env secrets as runtime env vars. It does not need Docker: the trainer only pays and
# verifies; grading happens on the provider nodes.
agentcore launch                                # builds, pushes, deploys the runtime
agentcore invoke '{"jobs": 4, "coordinator": "https://<public coordinator url>"}'
```

The coordinator and the grader nodes listen on 127.0.0.1, so a deployed runtime needs a public tunnel to the coordinator and to each grader endpoint.

Local dry run without the SDK: `python3 agentcore_app.py` prints a `dry_run` payload.

When it runs, add a screenshot or the invoke log to the top-level README under "AWS Bedrock AgentCore" and update its Status line.
