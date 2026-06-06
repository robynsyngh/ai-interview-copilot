# Copilot: bootup

Bring up the **whole** dev stack: Docker (postgres, pgadmin, api, web) plus the
Chrome extension watcher.

Run from the repo root:

```bash
./copilot bootup
```

This command tails the extension build logs and keeps running, so start it as a
long-running/background process rather than blocking on it. Docker keeps running
after you detach; use `/copilot-shutdown` (or `/copilot-stop`) to bring it down.

Endpoints once up: API → http://localhost:8000 · Web → http://localhost:3000 ·
pgAdmin → http://localhost:5050
