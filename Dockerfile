# ============================================
# 빌드 스테이지
# ============================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install pnpm globally (lockfile v6.0 호환 — pnpm v8)
RUN npm install -g pnpm@8

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile

# Copy source code and configuration files
# tsconfig.build.json 은 pnpm run build(tsc -p tsconfig.build.json)의 진입 설정이고
# tsconfig.json 을 extends 하므로 두 파일이 모두 있어야 한다 (하나라도 빠지면 TS5058).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Build the application
RUN pnpm run build

# ============================================
# 프로덕션 스테이지
# ============================================
FROM node:24-bookworm-slim

# 타임존 설정 (UTC 명시 — 모든 날짜는 UTC로 저장/처리, 표시 단계에서만 KST 변환)
ENV TZ=UTC

# 필요한 패키지만 설치 (Oracle 클라이언트 라이브러리 및 health check용 curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libaio1 \
    libnsl2 \
    libstdc++6 \
    libgcc-s1 \
    unzip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Install pnpm globally (lockfile v6.0 호환 — pnpm v8)
RUN npm install -g pnpm@8

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built application from builder stage
# dist 폴더에는 빌드된 JavaScript 파일과 config 파일이 모두 포함됩니다
COPY --from=builder /app/dist ./dist

# Copy tsconfig files for tsconfig-paths to resolve path aliases at runtime
# tsconfig.runtime.json은 런타임 기준(baseUrl=dist) 경로 매핑을 위해 필요합니다
COPY tsconfig.runtime.json ./tsconfig.runtime.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Expose the port your application runs on
EXPOSE 3500

# 헬스체크는 스택(infra/docker-stack.app.yml)에서만 정의한다 — 여기 값은 스택 값에 덮어써져 혼동만 남았다.
# curl은 그 헬스체크가 쓰므로 런타임 패키지에서 빼지 않는다.

# Run the built application with runtime tsconfig for path resolution
ENV TS_NODE_PROJECT=/app/tsconfig.runtime.json
CMD ["node", "-r", "tsconfig-paths/register", "dist/main.js"]