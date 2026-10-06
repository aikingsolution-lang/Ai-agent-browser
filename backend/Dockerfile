FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY backend ./backend
RUN pnpm -F @nanobrowser/backend build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/backend/dist ./backend/dist

EXPOSE 5000
CMD ["node", "backend/dist/server.js"]

