# Copilot: db

Open an interactive `psql` shell into the Postgres container.

Run from the repo root:

```bash
./copilot db
```

This is interactive — only run it when an interactive terminal is appropriate.
For non-interactive queries, instead run a one-off:

```bash
docker compose exec -T postgres psql -U copilot -d copilot -c "<SQL>"
```
