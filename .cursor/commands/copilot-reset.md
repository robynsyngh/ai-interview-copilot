# Copilot: reset

Rebuild the stack from scratch. **Destructive:** this wipes the Postgres data
volume, then rebuilds images and starts everything.

Confirm with the user before running, since all DB data is lost.

Run from the repo root:

```bash
./copilot reset
```
