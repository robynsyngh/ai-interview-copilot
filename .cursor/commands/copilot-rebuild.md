# Copilot: rebuild

Rebuild all images and start the stack, **keeping** the DB volume. Use this after
backend dependency changes (e.g. new Python packages) or Dockerfile edits.

Run from the repo root:

```bash
./copilot rebuild
```
