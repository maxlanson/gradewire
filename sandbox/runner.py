"""Gradewire sandbox test runner.

Runs every test_* function in every test_*.py file under /work, in sorted order, and
prints one JSON line with pass/fail per test. No timings, no addresses, no tracebacks:
the output must be identical on every honest machine.
"""
import importlib
import json
import os
import sys

WORK = "/work"
MARKER = "GRADEWIRE_RESULT "


def main():
    sys.path.insert(0, WORK)
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
    sys.stdout.write("\n" + MARKER + json.dumps({"tests": tests}, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
