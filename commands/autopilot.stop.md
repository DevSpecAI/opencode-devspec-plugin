---
description: Stop the DevSpec autopilot polling loop after the current cycle completes
---

# Stop DevSpec Autopilot

Stop the autopilot polling loop. If an action item is currently being processed, wait for it to finish before stopping. Do not interrupt mid-execution.

Output the stop banner with session stats:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  OFFLINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  session: {abbreviated_uuid} · host: {hostname}
  ran {N} cycles · {completed} completed · {failed} failed
  uptime: ~{duration}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Include the tracked state values (cycles_run, items_completed, items_failed, items_planned) from the running session. Abbreviate the session UUID (first 3 + last 4 chars, e.g., `fdd...88cb`). Do NOT output any filler text before or after the banner.
