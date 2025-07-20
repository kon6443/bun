FROM node:20-alpine

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
CMD ["pnpm", "exec", "tsx", "src/main.ts"]