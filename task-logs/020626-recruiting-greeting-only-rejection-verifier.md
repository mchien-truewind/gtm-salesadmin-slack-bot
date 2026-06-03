# Recruiting Greeting-Only Rejection Verifier

## Context
The rejection draft auto-send verifier was too strict: it treated noisy resume/OCR tokens as name conflicts and blocked valid greetings like "Hi Lori" and "Hi Abishek". The requested behavior is to verify only whether the greeting first name is correct.

## Plan
- Update the deterministic first-name verifier to focus on the draft greeting versus candidate identity evidence, not noisy resume tokens.
- Update the Anthropic verifier prompt to check only the salutation first name and ignore obvious resume/OCR section noise.
- Make the subagent result the send gate while preserving fail-closed behavior if the subagent cannot verify.
- Validate syntax and push to main for Railway.

## Acceptance
- Valid greetings like Lori/Abishek are allowed when they match candidate name/email evidence.
- Clear mismatches like "Hi Sharma" for Prakhar remain blocked.
- Production Railway uses the updated committed logic.
