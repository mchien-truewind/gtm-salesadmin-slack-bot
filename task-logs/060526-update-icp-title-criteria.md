# 060526 - Update ICP Title Criteria

## What Was Asked

The user asked to update Truewind's ICP/disqualification criteria so qualified titles include CFOs, CEOs, controllers, VPs of finance, and heads of finance, while excluding senior accountants, bookkeepers, treasurers, managers, and generic officers.

## What Was Done

- Updated ICP token constants in:
  - `scripts/bdr_lead_pipeline.js`
  - `scripts/hubspot_icp_cleanup.js`
- Removed:
  - `treasurer`
  - `bookkeeper`
  - `senior accountant`
  - `staff accountant`
  - `avp accountant`
  - `director finance`
  - `finance manager`
  - `chief accounting`
  - `finance officer`
- Kept:
  - `cfo`
  - `ceo`
  - `controller`
  - `head finance`
  - `vp finance`
  - `vice finance`
- Added:
  - `head financial`
  - `vp financial`
  - `vice financial`
  - `chief financial`
  - `chief executive`

## Decisions Made

- Treated the user's sentence excluding senior accountants as the controlling instruction, even though a later bullet mentioned senior accountants.
- Used `chief + financial` and `chief + executive` instead of generic `officer` matching, so `Chief Financial Officer` and `Chief Executive Officer` qualify without allowing unrelated officer titles.
- Kept the legacy cleanup script and current BDR pipeline criteria identical.

## Mistakes, Blockers, And Fixes

- No blockers. The main ambiguity was senior accountants; resolved by following the explicit exclusion.

## What Was Learned

- The previous criteria missed `Chief Financial Officer` because it checked `finance + officer`, not `financial + officer`.
- The matcher tokenizes titles and checks for exact tokens, so adding `chief + financial` is enough to catch `Chief Financial Officer` without keeping generic `finance officer`.

## Verification

- `node --check scripts/bdr_lead_pipeline.js`
- `node --check scripts/hubspot_icp_cleanup.js`
- `npm test`
- Manual classifier spot check:
  - included: CFO, Chief Financial Officer, CEO, Chief Executive Officer, Controller, VP of Finance, Vice President Financial Planning, Head of Finance
  - excluded: Senior Accountant, Bookkeeper, Treasurer, Finance Manager, Accounting Manager, Finance Officer
- Claude Code review approved with no blockers.

## Follow-Ups

- If the user wants, run the HubSpot contact update next: set qualified blank `contact_type` contacts to `Prospective Customer` and requalify disqualified contacts that now match the corrected criteria.
