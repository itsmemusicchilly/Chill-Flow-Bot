# Chill Flow Bot — works on any Docker host: PC, Raspberry Pi (arm64), NAS, VPS.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# HOST must be 0.0.0.0 inside a container, or the dashboard cannot be reached from outside it.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npm", "start"]
