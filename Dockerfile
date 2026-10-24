# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend
RUN npm install --global pnpm@12.3.4
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/src ./src
COPY frontend/public/external-systems ./public/external-systems
COPY design/tokens.css /build/design/tokens.css
COPY mock-provider/server.mjs /build/mock-provider/server.mjs
RUN pnpm test && pnpm build

FROM gradle:9.3.0-jdk17 AS backend-build
USER root
WORKDIR /build
COPY backend/build.gradle.kts backend/settings.gradle.kts backend/
COPY backend/src backend/src
COPY frontend/src/preview/fixtures/support.hwp frontend/src/preview/fixtures/support.hwp
COPY --from=frontend-build /build/frontend/dist frontend/dist
RUN gradle -p backend test bootJar --no-daemon

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend-build /build/backend/build/libs/bnoc-server-1.0.0.jar ./server.jar
COPY mock-provider/server.mjs ./mock-provider/server.mjs
COPY docker/supervisor.mjs docker/health.mjs ./docker/
RUN mkdir -p /data/attachments /evidence && chown -R node:node /data /evidence
ENV TZ=Asia/Seoul BNOC_PORT=8083 BNOC_BIND=0.0.0.0 BNOC_PROVIDER_URL=http://127.0.0.1:8082 BNOC_FILE_ROOT=/data/attachments
EXPOSE 8083
ENTRYPOINT ["node", "docker/supervisor.mjs"]

FROM runtime AS verification
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps chromium firefox && rm -rf /var/lib/apt/lists/*
COPY e2e ./e2e
COPY frontend/src/preview/fixtures/support.hwp ./frontend/src/preview/fixtures/support.hwp
COPY --from=backend-build /build/backend/build/test-results/test ./backend-unit-results
COPY docker/verify.mjs docker/persistence.mjs ./docker/

FROM node:22-bookworm-slim AS development
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless && rm -rf /var/lib/apt/lists/* && npm install --global pnpm@12.3.4
COPY --from=gradle:9.3.0-jdk17 /opt/gradle /opt/gradle
ENV PATH="/opt/gradle/bin:${PATH}" TZ=Asia/Seoul BNOC_PORT=8084 BNOC_BIND=127.0.0.1 BNOC_PROVIDER_URL=http://127.0.0.1:8082 BNOC_FILE_ROOT=/data/attachments
WORKDIR /workspace
COPY docker/development.mjs docker/development-backend.mjs docker/development.gradle docker/supervisor.mjs docker/health.mjs /opt/bnoc/docker/
ARG BNOC_DEV_FINGERPRINT
ARG BNOC_DEV_DEPENDENCIES
ENV BNOC_DEV_DEPENDENCIES=${BNOC_DEV_DEPENDENCIES}
LABEL bnoc.development.fingerprint=${BNOC_DEV_FINGERPRINT}
ENTRYPOINT ["node", "/opt/bnoc/docker/development.mjs"]
