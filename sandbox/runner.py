"""Gradewire sandbox runner.

Two job kinds, both deterministic by construction:

- python-script:   /work/main.py exists. Run it, capture stdout (bounded), report the output.
- python-fn-tests: run every test_* function in every test_*.py under /work, in sorted order,
                   report pass/fail per test.

Prints one JSON line. No timings, no addresses, no tracebacks: the output must be identical
on every honest machine, so a verifier's re-run either matches exactly or proves cheating.
"""
import importlib
import json
import os
import subprocess
import sys

WORK = "/work"
SCRIPT = os.path.join(WORK, "main.py")
MARKER = "GRADEWIRE_RESULT "
MAX_OUTPUT = 16 * 1024  # bytes of stdout kept in the result


def run_script():
    """Run main.py in a child interpreter and capture its stdout byte-exactly.

    A child process (rather than redirecting sys.stdout in-process) means the OS, not Python
    monkeypatching, decides what counts as output, so every exit path is handled the same way:

    - Captured: everything the program writes to file descriptor 1, whether through print(),
      sys.stdout, or os.write(1, ...). Bytes beyond MAX_OUTPUT are dropped and `truncated` is set.
      Invalid UTF-8 decodes with U+FFFD replacement, so the text is still deterministic.
    - Not captured: stderr (tracebacks, warnings, logging) goes to /dev/null and can never leak
      into the hash. stdin is /dev/null, so input() raises EOFError instead of hanging.
    - Ordering: fd 1 is a pipe, so print() is block-buffered and flushed at exit while
      os.write(1, ...) is immediate; raw writes therefore come first in the capture regardless
      of program order. The same rule applies on every machine, so the hash still matches.
    - Lost on purpose: text left in the stdio buffer when the program calls os._exit() is
      discarded, exactly as a shell pipeline would discard it. That loss is identical everywhere.
    - exit_code is the child's return code; a signal death (OOM kill, os.kill) is reported as
      the negative signal number, as subprocess does.
    - Fixed context: sys.argv == ["/work/main.py"], __file__ == "/work/main.py", cwd /work,
      sys.path[0] == /work (sibling modules import normally). HOSTNAME is dropped from the
      environment because Docker sets it to the random container id.

    Scripts that read the clock, randomness, PIDs or hardware details are non-deterministic by
    their own doing and are the buyer's problem to avoid, as with flaky tests.
    """
    env = {k: v for k, v in os.environ.items() if k != "HOSTNAME"}
    proc = subprocess.Popen(
        [sys.executable, "-B", SCRIPT],
        cwd=WORK,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    chunks = []
    size = 0
    fd = proc.stdout.fileno()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        if size < MAX_OUTPUT:
            chunks.append(chunk)
        size += len(chunk)  # keep draining so a chatty program is bounded by its timeout, not memory
    proc.stdout.close()
    exit_code = proc.wait()
    data = b"".join(chunks)[:MAX_OUTPUT]
    return {"output": data.decode("utf-8", "replace"), "truncated": size > MAX_OUTPUT, "exit_code": exit_code}


def run_tests():
    tests = []
    for filename in sorted(os.listdir(WORK)):
        if not (filename.startswith("test_") and filename.endswith(".py")):
            continue
        module_name = filename[:-3]
        try:
            module = importlib.import_module(module_name)
        except BaseException:  # a broken import fails the file's tests, it is not a runner error
            tests.append({"name": f"{filename}::<import>", "passed": False})
            continue
        names = sorted(n for n in vars(module) if n.startswith("test_") and callable(getattr(module, n)))
        for name in names:
            try:
                getattr(module, name)()
                passed = True
            except BaseException:
                passed = False
            tests.append({"name": f"{filename}::{name}", "passed": passed})
    return {"tests": tests, "exit_code": 0}


def main():
    sys.path.insert(0, WORK)
    result = run_script() if os.path.exists(SCRIPT) else run_tests()
    sys.stdout.write("\n" + MARKER + json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
