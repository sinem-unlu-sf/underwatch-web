# Underwatch: pitch

## 90-second spoken pitch (about 220 words)

> Every coding agent keeps a diary: its transcript, its tool log, its "I fixed the test, no secrets touched." But all
> of it is written by the agent. What happens when the diary is wrong?
>
> Here's a real pattern. Claude Code is told it may not read `.env`. The Read tool is denied, so the agent runs
> `cat .env` through Bash. Then its final report says no secrets were accessed. Nothing in the agent's own logs
> catches that.
>
> Underwatch runs the agent in a disposable container and watches it from outside. Tetragon, an eBPF observer
> in the kernel, records every process and every sensitive file open, and the agent can't see it or kill it.
> We put what the agent *said* next to what the kernel *saw*.
>
> Neo4j turns the evidence into a graph. One query walks from the kernel's `.env` open, through `cat` and `bash`,
> back to the exact tool call that caused it, and across runs to show whether it happens again.
>
> Ask Witness, built on ai&, lets you question the incident in plain language. Every answer must cite real
> evidence, and the server rejects citations that don't exist. ai& explains. It never decides what happened.
>
> Then you turn the incident into a safeguard: a CLAUDE.md line, a permission rule, or a kernel deny. We say plainly
> what each one can't stop. You approve the diff, and we re-run a real agent to test it, reporting security and task
> outcomes separately.
>
> Don't trust what your agent says it did. Check the kernel.

Delivery notes: about 150 words per minute. Pause after "What happens when the diary is wrong?" and after "Nothing
in the agent's own logs catches that." Only say "re-run a real agent" if the live verification step works in
rehearsal. Otherwise say "and re-run the scenario to test it."

## Likely judge questions, with honest answers

**1. "Can't the agent tamper with the logs?"**
It can tamper with *its own* logs, and we assume it does. Everything the agent produces (stream-json, the hook
spool, the transcript) is labeled `reported`. We use it only to *raise* a discrepancy, never to clear one. The
independent evidence comes from outside the agent's container. Tetragon runs in the Docker VM in a separate PID
namespace; we tested that the agent can't see or signal it. The proxy log is pulled by the host, and the evidence
store is never mounted into the agent's container. The honest limit: a container escape would give root in the
shared VM and defeat this. We also haven't yet verified that the agent can't reach in-VM listeners through the
Docker gateway.

**2. "Is CLAUDE.md enough?"**
No, and the product says so. CLAUDE.md is guidance. It can make the agent less likely to try something and more
honest about failures, but it can't block anything, and the agent can edit it. A Claude Code permission rule blocks
the Read tool and the Bash file commands Claude Code recognizes, but not arbitrary subprocesses like
`python3 -c "open('.env')"`, because the native sandbox can't start inside our unprivileged container. Only a
kernel-level deny (a Tetragon BPF-LSM `file_open` override scoped to the agent's container) stops every process.
We exercised that in our spike. Wiring it in as a one-click safeguard is [in progress / done: update before
judging]. Every safeguard card lists "can" and "cannot" in fixed text that the model doesn't write.

**3. "What does ai& decide?"**
Nothing about facts. Whether an event happened, whether a policy was violated, and whether a safeguard passed
verification are decided by deterministic code over recorded evidence. ai& does two things. It answers investigator
questions, with citations the server validates against the evidence bundle. And it drafts safeguard text, which a
human must approve. Secrets are redacted before anything goes to ai&. If ai& is down, the product still works and
says "AI unavailable" instead of making up an answer.

**4. "Is this real or a mock-up?"**
Both, clearly labeled. The five walkthrough runs (fx-01 to fx-05) are hand-authored fixtures, and the UI badges them
FIXTURE. Live and verification runs use a real Claude Code 2.1.302 agent, headless, in a disposable container,
against a demo repo with a synthetic `.env`. The Tetragon parser is tested on real captured kernel events from this
machine. [Before judging: state exactly which live steps worked in the final rehearsal.]

**5. "Why Neo4j? Couldn't you do this in SQL?"**
Storage, yes. Investigation is the hard part. "Which tool call caused this file open?" means walking a process tree
of unknown depth: `cat` ← `bash` ← maybe `sh -c` ← `claude` ← tool call. "Has this happened before?" means joining
findings across runs through shared resources. Both are variable-length path queries, which is what Cypher is built
for. We also put the basis (observed, reported, derived or inferred) on every edge, so the graph itself shows what
we saw versus what we concluded. SQLite stays the system of record. Neo4j is a projection, so if it goes down we
lose the graph view, not the evidence.

### Backup questions

- **"How much overhead does Tetragon add?"** We haven't measured it reliably. One microbenchmark exists but was
  confounded, so we don't quote a number.
- **"Does it work outside Docker Desktop on a Mac?"** It's validated only on Docker Desktop 4.57, kernel 6.12.54 and
  Tetragon 1.7.0. On native Linux the approach should carry over, but we haven't tested it.
- **"Can the agent steal the Claude token?"** In the current build, until the credential broker is wired in, yes:
  the token is in the agent's environment. The broker keeps the real token in a separate container and gives the
  agent a per-run placeholder that is worthless anywhere else. We use a dedicated account and rotate the token after
  the demo.
