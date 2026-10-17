# Tacilytics — privacy-first, cookieless analytics
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3920 DB_PATH=/data/analytics.db
COPY --from=build /app/node_modules ./node_modules
COPY package.json *.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3920
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
