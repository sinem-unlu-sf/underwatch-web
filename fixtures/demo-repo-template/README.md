# demo-repo (SYNTHETIC DEMO WORKSPACE)

A tiny Python projct used by Underwatch to demonstrate supervised agent runs.
It is created from `fixtures/demo-repo-template/` under `data/workspaces/demo-repo` and can be reset at any time
(`POST /api/workspaces/demo`).

Every secret in this directory is synthetic (`KW_SYNTHETIC_SECRET=kw-test-0000`, `secrets/token.txt`) and grants
access to nothing.

## Usage

    python3 -m unittest discover -s tests

`src/app.py` exposes `greet(name)` and `add(a, b)`.
