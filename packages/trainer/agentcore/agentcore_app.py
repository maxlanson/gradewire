"""Gradewire as an Amazon Bedrock AgentCore Runtime.

NOT YET DEPLOYED: no AWS credentials were available while building. The file follows the
AgentCore Runtime HTTP contract as documented on Oct 24 2026 (BedrockAgentCoreApp serves
POST /invocations and GET /ping on port 8080; one @app.entrypoint handler that takes the JSON
payload and returns a JSON-serialisable dict). See README.md next to this file for the deploy steps.

Two tools, selected by the payload:

  {"question": "...", "parts": 3}     gradewire.ask            verified pay-per-job compute:
      runs the ask agent (scripts/ask.sh), which plans deterministic Python programs with Claude,
      pays untrusted nodes per job over Mastercard AP4M x402 (RLUSD on XRPL EVM Testnet), waits for
      the on-chain verdicts and answers only from verified output. Returns the final answer plus the
      payment and verdict lines parsed from the run.
  {"jobs": 4}                         gradewire.grade_rollouts the RL workload: the trainer sends
      python-fn-tests jobs through the same paying engine and returns the accepted grades.

The runtime does no compute itself: the model call (ANTHROPIC_API_KEY; there is no `claude` CLI
inside the container) and the x402 payments happen here, the programs run on the nodes.
"""
import json
import os
import re
import subprocess

try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp  # type: ignore
except ImportError:  # local dry runs without the SDK
    class BedrockAgentCoreApp:  # minimal stand-in so the module imports
        def entrypoint(self, fn):
            return fn

        def run(self):
            print(json.dumps({
                "ask": invoke({"question": "How many primes are below 10 million?", "parts": 3, "dry_run": True}),
                "grade_rollouts": invoke({"jobs": 2, "dry_run": True}),
            }, indent=2))


app = BedrockAgentCoreApp()
REPO = os.environ.get("GRADEWIRE_REPO", os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
TIMEOUT_S = int(os.environ.get("GRADEWIRE_TIMEOUT_S", "900"))

ANSI = re.compile(r"\x1b\[[0-9;]*m")
STAMP = re.compile(r"^\d\d:\d\d:\d\d ")


def _node_cmd(script, args):
    """Run a Gradewire script the way scripts/ask.sh and scripts/trainer.sh do. On the laptop `.env`
    exists and node loads it; in the AgentCore container there is no .env and every variable comes
    from the runtime environment, so --env-file-if-exists keeps one command for both."""
    return ["node", "--env-file-if-exists=.env", script, *args]


def _run(cmd):
    env = {**os.environ, "TEAM_NAME": os.environ.get("TEAM_NAME", "FranksDAO")}
    env.pop("CLAUDECODE", None)
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=TIMEOUT_S, env=env)
    lines = [STAMP.sub("", ANSI.sub("", l)).rstrip() for l in proc.stdout.splitlines()]
    return proc, lines


def _ask(payload):
    question = str(payload.get("question", "")).strip()
    if not question:
        return {"tool": "gradewire.ask", "error": "payload.question is required"}
    parts = int(payload.get("parts", 3))
    args = [question, "--parts", str(parts), "--max-price", str(payload.get("max_price", "0.01")), "--min-score", str(payload.get("min_score", "0.8"))]
    if payload.get("no_settle", True):
        args.append("--no-settle")       # settlement is automatic on the AP4M side; skipping it keeps invocations short
    if payload.get("plan_only"):
        args.append("--dry-run")         # the ask agent plans the programs but pays nobody
    if payload.get("node"):
        args += ["--node", str(payload["node"])]
    coordinator = payload.get("coordinator") or os.environ.get("COORDINATOR_URL")
    if coordinator:
        args += ["--coordinator", coordinator]
    cmd = _node_cmd("packages/ask/index.mjs", args)
    if payload.get("dry_run"):
        return {"tool": "gradewire.ask", "status": "dry_run", "question": question, "parts": parts, "command": cmd,
                "needs_env": ["ANTHROPIC_API_KEY", "AGENT_PRIVATE_KEY", "AP4M_API_URL", "COORDINATOR_URL (public)"]}
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"tool": "gradewire.ask", "error": "ANTHROPIC_API_KEY is not set in the runtime environment; the container has no `claude` CLI, so the ask agent needs the Anthropic SDK path"}
    proc, lines = _run(cmd)

    # The final answer is printed between the "┌─ answer" and "└──" rules, one "│ " line each.
    answer = []
    inside = False
    for l in lines:
        if l.startswith("┌─ answer"):
            inside = True
            continue
        if inside and l.startswith("└─"):
            inside = False
            continue
        if inside:
            answer.append(l[2:] if l.startswith("│ ") else l.lstrip("│"))
    footer = next((l for l in lines if l.startswith("paid ") and "AP4M x402" in l), None)
    return {
        "tool": "gradewire.ask",
        "exit_code": proc.returncode,
        "question": question,
        "answer": "\n".join(answer).strip() or None,
        "plan": [l for l in lines if l.startswith("[plan]")],
        "nodes": [l for l in lines if l.startswith("[nodes]")],
        "payments": [l for l in lines if " paid " in l and "VoucherRedeemed" in l],
        "verdicts": [l for l in lines if (" verified:" in l) or (" FAILED verification" in l) or (" not sampled" in l)],
        "fraud": [l for l in lines if l.startswith("[slash]") or l.startswith("[reroute]") or " FAILED verification" in l],
        "settlement": [l for l in lines if l.startswith(("[settled]", "[receipt]", "[closed]"))],
        "summary": footer,
        "stderr": proc.stderr[-2000:],
    }


def _grade_rollouts(payload):
    jobs = int(payload.get("jobs", 6))
    args = ["--jobs", str(jobs)]
    coordinator = payload.get("coordinator") or os.environ.get("COORDINATOR_URL")
    if coordinator:
        args += ["--coordinator", coordinator]
    if payload.get("node"):
        args += ["--node", str(payload["node"])]
    cmd = _node_cmd("packages/trainer/index.mjs", args)
    if payload.get("dry_run"):
        return {"tool": "gradewire.grade_rollouts", "status": "dry_run", "jobs": jobs, "command": cmd}
    proc, lines = _run(cmd)
    return {
        "tool": "gradewire.grade_rollouts",
        "exit_code": proc.returncode,
        "accepted_grades": [l for l in lines if " paid " in l],
        "fraud_events": [l for l in lines if "FAILED verification" in l or "fraud:" in l or "[slash]" in l],
        "summary": [l for l in lines if "[trainer]" in l][-4:],
        "stderr": proc.stderr[-2000:],
    }


@app.entrypoint
def invoke(payload: dict) -> dict:
    """AgentCore Runtime entrypoint: the JSON body of POST /invocations, returned as JSON."""
    if "question" in payload:
        return _ask(payload)
    if "jobs" in payload:
        return _grade_rollouts(payload)
    return {"error": "send {\"question\": \"...\", \"parts\": 3} for gradewire.ask or {\"jobs\": n} for gradewire.grade_rollouts"}


if __name__ == "__main__":
    app.run()
