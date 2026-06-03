# syntax=docker/dockerfile:1

# ── deps: install production node_modules in a cacheable layer ──────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini = correct PID 1 so SIGTERM reaches node and index.js shuts down gracefully
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY migrations ./migrations

# uploads/ is a mounted volume at runtime; create the mount point so the
# media layer (src/media/fs.js) can write before the volume is populated.
RUN mkdir -p /app/uploads

EXPOSE 3001

# Any HTTP response (even 404) means the server is up. Only a refused
# connection -> unhealthy. We talk plain HTTP here on purpose: TLS is
# terminated by Traefik, the container itself never holds certs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/',r=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
