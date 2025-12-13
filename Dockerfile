# ============================================
# 빌드 스테이지
# ============================================
FROM node:20-bullseye-slim AS builder

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile

# Copy source code and configuration files
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN pnpm run build

# ============================================
# 프로덕션 스테이지
# ============================================
FROM node:20-bullseye-slim

# 필요한 패키지만 설치 (Oracle 클라이언트 라이브러리)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libaio1 \
    libnsl2 \
    libstdc++6 \
    libgcc-s1 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built application from builder stage
# dist 폴더에는 빌드된 JavaScript 파일과 config 파일이 모두 포함됩니다
COPY --from=builder /app/dist ./dist

# Expose the port your application runs on
EXPOSE 3500

# Run the built application
CMD ["pnpm", "start:prod"]