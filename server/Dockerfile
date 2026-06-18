FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js maintenance.js pace.js volume.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
