# Engineering notes

The conversation records visible history. A task records its lifecycle. Tools report facts and receipts; the Agent uses those results to choose the next step.

## Durable events

Store a snapshot and cursor. Reconnect after that cursor, ignore already applied events, and resnapshot when history expires. Task execution must not depend on a browser staying connected.

## Bounded work

Use one active task per conversation. Input URL count, active workers and open browser pages are separate measures. Raise concurrency only after checking memory, failure rate and provider limits.

## Files as results

Record the producing task, name, size and version. Separate original uploads from generated delivery files. Verify availability at download time.

## Portable configuration

Model names, credentials, service addresses, workspace roots and retention belong in operator configuration. Source must not contain a preconfigured private deployment.

Concrete package choices are documented in [TECH_STACK.md](TECH_STACK.md).