"""Gradewire trainer as an Amazon Bedrock AgentCore Runtime entrypoint.

SCAFFOLD, NOT YET DEPLOYED: this file follows the AgentCore Runtime contract (an app with a
single @entrypoint handler, packaged with `agentcore configure` / `agentcore launch`) and
exposes Gradewire as the agent's paid tool. It has not been run on AWS yet because the team
had no AWS credentials at build time; see README "AWS AgentCore" for the steps left.

The agent payload selects how many rollouts to grade; the handler runs the Node trainer,
which does the x402 payments autonomously, and returns the structured summary.
"""
import json
import os
import subprocess

try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp  # type: ignore
except ImportError:  # local dry runs without the SDK
    class BedrockAgentCoreApp:  # minimal stand-in so the module imports
        def entrypoint(self, fn):
            return fn

        def run(self):
            print(json.dumps(invoke({"jobs": 2, "dry_run": True})))


app = BedrockAgentCoreApp()
REPO = os.environ.get("GRADEWIRE_REPO", os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))


@app.entrypoint
def invoke(payload: dict) -> dict:
    jobs = int(payload.get("jobs", 6))
    if payload.get("dry_run"):
        return {"tool": "gradewire.grade_rollouts", "jobs": jobs, "status": "dry_run"}
    cmd = ["node", "--env-file=.env", "packages/trainer/index.mjs", "--jobs", str(jobs)]
    if payload.get("coordinator"):
        cmd += ["--coordinator", payload["coordinator"]]
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=900)
    lines = proc.stdout.strip().splitlines()
    return {
        "tool": "gradewire.grade_rollouts",
        "exit_code": proc.returncode,
        "accepted_grades": [l for l in lines if " paid " in l],
        "fraud_events": [l for l in lines if "FAILED verification" in l or "fraud:" in l],
        "summary": [l for l in lines if "[trainer]" in l][-4:],
        "stderr": proc.stderr[-2000:],
    }


if __name__ == "__main__":
    app.run()
