FROM node:20-slim
# ffmpeg re-encodes a voice clip too large for Groq's upload cap (see /api/voice-command)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
# dev deps too: esbuild bundles the client below, then gets pruned back out
RUN npm install
# Everything in server/ that .dockerignore does not exclude, so a new directory ships without anyone
# having to list it here.
COPY . .
# Build the client here rather than committing public/dist, so the bundle a machine serves can never
# be stale against the source it was built from — no one has to remember to rebuild before deploying.
RUN npm run build && npm prune --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
