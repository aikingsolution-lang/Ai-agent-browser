# Build & Deployment Guide

## 1. Extension Build & Packaging

### Production Build
From the monorepo root:
```bash
pnpm build
```
This executes:
1. `turbo ready` (workspace preparation)
2. `turbo type-check` (verifies TypeScript types across all 8 workspaces)
3. `turbo build` (builds Vite extension, pages, and shared libraries into `dist/`)

### Packaging for Chrome Web Store
```bash
pnpm zip
```
Generates the deployable zip bundle at:
```
dist-zip/JobPilot-Extension-Latest.zip
```

---

## 2. Backend Server Deployment

### Docker Deployment
The backend can be containerized using Node 20 Alpine:
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/
RUN pnpm install --filter backend...
COPY backend/ backend/
RUN pnpm --filter backend build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/package.json ./
ENV NODE_ENV=production
EXPOSE 5000
CMD ["node", "dist/server.js"]
```

### Environment Verification Before Deployment
- Ensure `NODE_ENV=production`.
- Set strong random `JWT_SECRET` and `JWT_REFRESH_SECRET`.
- Provide live `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.
- Provide the Firebase service account (`FIREBASE_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`, `FIREBASE_DATABASE_URL`) and merge the `nanobrowser` index rules — see [FIREBASE_RTDB_MIGRATION.md](./FIREBASE_RTDB_MIGRATION.md).
