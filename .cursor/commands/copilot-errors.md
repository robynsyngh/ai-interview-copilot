# Copilot: errors

Show only errors/warnings from the recent logs of a service (defaults to `api`).
Pass a service name as extra input to inspect a different one: `api`, `web`,
`postgres`, or `pgadmin`.

Run from the repo root (substitute the requested service for `<svc>`, defaulting
to `api`):

```bash
./copilot errors <svc>
```

After running, summarize the notable errors/warnings and likely root cause.
