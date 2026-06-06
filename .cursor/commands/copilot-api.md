# Copilot: api

Rebuild and restart only the **api** container. Use after backend changes in
`apps/api` or new Python dependencies (e.g. `pypdf`, `python-docx`).

Run from the repo root:

```bash
./copilot api
```

API → http://localhost:8000 · docs → http://localhost:8000/docs
