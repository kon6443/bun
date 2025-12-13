FROM node:20-bullseye-slim

# 필요한 패키지만 설치 (불필요한 것 제거)
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

# Copy package.json and pnpm-lock.yaml first to leverage Docker's build cache
COPY package.json pnpm-lock.yaml ./

# Install dependencies using pnpm
# --frozen-lockfile ensures that the exac versions from pnpm-lock.yaml are used
RUN pnpm install --frozen-lockfile

# Copy the rest of your application code
COPY . .

# Expose the port your application runs on
EXPOSE 3500

# Command to run your application using tsx via pnpm exec
# pnpm exec will find tsx in node_modules/.bin
# CMD ["pnpm", "exec", "tsx", "src/main.ts"]
CMD ["pnpm", "start:prod"]