
### Risks
- Port drift: s3rf fixes (cardVars, stall detection, prompt-note merge, auto-panes) must all land in bandit, not get lost
- TradingFrontDesk has live in-flight card 004 — migration must preserve it

### Plan
Port modules from s3rf (rename .serf3→.bandit throughout), add event-driven board wake, keep proven code identical.
