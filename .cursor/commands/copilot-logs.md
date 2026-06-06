# Copilot: logs

Follow live logs for a service. Defaults to `api`. Pass a service name as extra
input to follow a different one: `api`, `web`, `postgres`, or `pgadmin`.

Run from the repo root (substitute the requested service for `<svc>`, defaulting
to `api` if none was given):

```bash
./copilot logs <svc>
```

This streams continuously, so run it as a long-running/background process.
