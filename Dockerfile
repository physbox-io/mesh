# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Copy the entire project context
COPY . .

# Needed to install @physbox-io/ui and @physbox-io/machining from GitHub
# Packages (see .npmrc)
ARG GITHUB_TOKEN
ENV GITHUB_TOKEN=$GITHUB_TOKEN

# Build the frontend application
# `ci`, not `install`: the lockfile is what the tests ran against, and the
# shared @physbox-io packages are on a caret range. `npm install` is free to
# resolve a newer minor at build time, so a deploy could ship a version of the
# machine layer nobody had run — quietly, and only in the image.
RUN npm ci

# `build:image`, not `build`: the latter is `tsc -b && vite build`, and the
# typecheck half already ran in GitHub Actions, which is what gates this image
# being built at all — Cloud Build only sees the `deploy` branch, and only the
# test workflow writes to it. Every tsconfig here is noEmit, so `tsc -b`
# produces nothing vite needs; running it again only repeats the check against
# the same lockfile, in a container with no cache, on every deploy.
RUN npm run build:image

# Production stage
FROM nginx:stable-alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Set default port for local testing or Cloud Run fallback
ENV PORT=8080

# Copy custom nginx config as a template for envsubst
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
