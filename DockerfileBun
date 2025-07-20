# Use the official Bun image
FROM oven/bun:latest

# Set the working directory
WORKDIR /app

# Copy package.json and bun.lockb first (for caching dependencies)
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3500

# Command to run your application
CMD ["bun", "src/main.ts"]