# Native SQLite is compiled in a builder, not on the persistent runtime disk.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production STORE_MODE=live HOST=0.0.0.0 PORT=3000 \
    DATA_DIR=/var/data PERSISTENT_STORAGE=true SEED_ON_BOOT=false \
    PAYMENT_PROVIDER=paystack GATEWAY_MODE=live NOTIFICATIONS_ENABLED=true
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p /var/data && chown node:node /var/data
USER node
VOLUME ["/var/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
