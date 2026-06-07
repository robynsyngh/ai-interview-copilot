# Git hooks

Version-controlled hooks for this repo. They are enabled by pointing Git at this
directory instead of `.git/hooks`:

```bash
pnpm hooks:install   # runs: git config core.hooksPath .githooks
```

This also runs automatically via the root `prepare` script on `pnpm install`.

## Hooks

| Hook         | What it does |
|--------------|--------------|
| `pre-commit` | Lints + type-checks **only the workspaces with staged changes**: `next lint` + `tsc` for `apps/web`, `tsc` for `apps/extension` and `packages/shared`, and `ruff check` / `ruff format --check` for `apps/api` (`*.py`). If `ruff` isn't installed locally it falls back to the running `api` Docker container. |
| `commit-msg` | Enforces [Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <subject>`. |

## Naming conventions enforced

- **Python** (`apps/api`): ruff `pep8-naming` (`N`) — snake_case functions/variables, PascalCase classes.
- **TypeScript** (`apps/web`): `@typescript-eslint/naming-convention` — camelCase variables/params, PascalCase types/components.

## Bypass (emergency only)

```bash
git commit --no-verify
```
