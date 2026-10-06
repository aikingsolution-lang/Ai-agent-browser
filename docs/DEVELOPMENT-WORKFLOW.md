# Development & Contribution Workflow

## 1. Branching & Commit Conventions
- **Main Branch**: `main` (represents stable, deployable code).
- **Feature Branches**: `feature/<feature-name>`, `fix/<bug-name>`.
- **Commit Messages**: Conventional commits format:
  - `feat: add tab-mode boundary check for naukri`
  - `fix: prevent candidate name in search role resolution`
  - `docs: complete codebase audit and handover guide`

---

## 2. Pre-Commit Verification
The repository uses **Husky** for Git hooks:
```bash
# Run type check across all workspaces
pnpm type-check

# Run linter
pnpm lint

# Run unit tests
pnpm -F chrome-extension test
pnpm -F backend test
```

---

## 3. Local Development Iteration Loop
- **Backend**: Run `pnpm dev` in `backend/` (`tsx watch src/server.ts`). Auto-reloads on file save.
- **Extension**: Run `pnpm dev` in root or `chrome-extension/`. Chrome Vite plugin supports HMR for UI and background scripts.
