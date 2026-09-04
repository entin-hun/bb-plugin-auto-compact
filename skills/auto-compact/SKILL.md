---
name: auto-compact
description: Automatically compacts thread context when usage nears the model's limit. Use when asking about context usage, compaction settings, or manually checking a thread.
---

# Auto Compact

This plugin watches thread context-window usage and compacts threads
automatically once usage reaches a configurable percentage (default 80%).

## How it works

- When a thread goes idle or fails, the plugin reads its `contextWindowUsage`
  (used tokens vs. model window) and calls `threads.compact` if usage is at
  or above the threshold.
- A 15-minute per-thread cooldown prevents repeated compactions when usage
  stays high.
- Compaction only ever runs on idle or failed threads, which is when BB
  allows it. Active threads are never interrupted.

## CLI

```sh
bb auto-compact status [--json]
bb auto-compact check [thread-id] [--json]
bb auto-compact now [thread-id] [--json]
```

- `status` prints whether auto-compact is enabled, the threshold percent,
  and the cooldown.
- `check` runs the threshold check immediately against the given thread
  (defaults to the current thread when run inside one) and compacts it when
  over threshold. Use it to verify behavior instead of waiting for a thread
  to go idle.
- `now` compacts immediately, bypassing threshold and cooldown. Same action
  as the thread header's Compact button.

## Manual compaction

Every thread header has a **Compact** button (added by this plugin) that
compacts the visible thread on demand, with a toast confirming the result.
It works even when the thread is below the auto-compact threshold or when
auto-compact is disabled. The button shows the thread's live context usage
next to the label (turning red at the threshold) and a spinner while a
compaction runs.

## Limitations

Some providers cannot compact at all (certain ACP bridges fail with
"<provider> does not support manual compaction"). On those threads the
Compact button says the provider doesn't support compaction, and automatic
checks skip quietly instead of retrying on every idle event.

## Settings

Configure under Extensions → Plugins → Auto Compact, or via:

```sh
bb plugin config auto-compact set enabled false
bb plugin config auto-compact set thresholdPercent 90
```

- `enabled` (boolean, default `true`) — master switch.
- `thresholdPercent` (one of 70, 75, 80, 85, 90, 95; default `80`) —
  context usage percent that triggers compaction.
