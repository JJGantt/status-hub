FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
# dev deps too: esbuild bundles the client below, then gets pruned back out
RUN npm install
COPY server.js build.js ./
COPY lib ./lib
COPY public ./public
COPY legal ./legal
# Build the client here rather than committing public/dist, so the bundle a machine serves can never
# be stale against the source it was built from — no one has to remember to rebuild before deploying.
RUN npm run build && npm prune --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
