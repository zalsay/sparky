FROM docker.xuanyuan.run/node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM docker.xuanyuan.run/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/home/app
ENV SHELL=/bin/sh
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && addgroup -S app \
  && adduser -S -G app -h /home/app app \
  && mkdir -p /home/app /workspace \
  && chown -R app:app /app /home/app /workspace
COPY --from=builder /app/dist ./dist
USER app
EXPOSE 3210
CMD ["node", "dist/server.js"]
