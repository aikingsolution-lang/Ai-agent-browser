FROM node:22-alpine AS builder

WORKDIR /app

# Copy package definition and install all dependencies (including devDependencies for build)
COPY backend/package.json ./
RUN npm install

# Copy backend source and compile TypeScript
COPY backend/ ./
RUN npm run build

# Production runtime stage
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY backend/package.json ./
RUN npm install --omit=dev

# Copy compiled JavaScript output
COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/server.js"]
