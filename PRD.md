---
task: Bandit chat mode design
slug: 20260917-bandit-chat-mode
effort: standard
phase: complete
progress: 5/5
mode: interactive
started: 2026-09-17T01:00:00Z
updated: 2026-09-17T01:10:00Z
---

## Context
User: why kill the loop? Serfs should live in the loop watching the board forever, and the human should walk in and CHAT with them (actor/critic) with the agent of choice. Not watch paint dry.

## Criteria
- [x] ISC-1: The resident-loop design (serfs live in the loop)
- [x] ISC-2: Chat mode: human joins the loop, not a separate process
- [x] ISC-3: How the human talks to a serf (herdr pane typing + file mail)
- [x] ISC-4: Agent-of-choice at chat time
- [x] ISC-5: Implementation

## Verification
Design against herdr capabilities + s3rf watch pattern.

## Decisions
bandit chat [role] — attaches the human INTO the resident loop: picks the pane, drops you in with your agent of choice; serfs stay resident between cards.