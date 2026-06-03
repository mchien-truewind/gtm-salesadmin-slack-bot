# Recruiting Offered Terminal Status

## Context
The user wants `Offered` treated as a terminal ATS status so automation does not overwrite it or include it in active follow-up handling.

## Plan
- Add `Offered` to status options/schema defaults if needed.
- Add `offered` to terminal status checks.
- Validate syntax and push to main.

## Acceptance
- Rows marked `Offered` are treated like `Rejected`, `Passed`, `Accepted`, and `N/A`.
- Railway receives the change from `main`.
