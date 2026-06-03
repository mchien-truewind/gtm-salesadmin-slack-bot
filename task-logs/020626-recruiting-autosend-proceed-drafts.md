# Recruiting Auto-Send Proceed Drafts

## Context
The user wants non-rejection drafts that represent candidates proceeding to be auto-sent as well. Existing code creates proceed drafts but does not auto-send them.

## Plan
- Inspect current proceed-draft lifecycle in `coordinator_cli.py`.
- Add auto-send handling for ATS rows in `Proceed Drafted` with a linked proceed draft id.
- Set status after send based on flow: CustomGPT roles move to `In CustomGPT Process`; normal intro-call proceeds move to `Scheduling`.
- Run a one-off send pass for existing Gmail proceed/custom-GPT drafts matched to ATS rows.
- Validate, commit, push, and verify Railway deploy.

## Acceptance
- Future proceed drafts auto-send from Railway.
- Existing proceed/custom-GPT drafts get sent once if ATS-matched.
- Rejection logic remains unchanged.
