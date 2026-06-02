# Recruiting Rerun Reliability

## Context
The rejection-draft rerun was blocked after Railway got the Anthropic key: `process-decisions` hit a Gmail read timeout while resolving related candidate threads, and the production worker is also failing in `ingest` on a Drive upload `BrokenPipeError` before decisions run.

## Plan
- Add bounded retries around Google API execute calls used by Drive upload and Gmail thread search.
- Isolate per-candidate decision processing enough that a Gmail lookup failure does not abort the whole command.
- Rerun decision processing with Railway production env and verify summary counters.

## Acceptance
- `process-decisions` does not abort on transient Gmail/Drive network errors.
- Rejection draft auto-send can reach the verifier path now that the Anthropic key is configured.
- The rerun produces summary counters or clear per-candidate skip logs.
