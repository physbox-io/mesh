# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Copy the entire project context
COPY . .

# Needed to install @physbox-io/ui from GitHub Packages (see .npmrc)
ARG GITHUB_TOKEN
ENV GITHUB_TOKEN=$GITHUB_TOKEN

# Build the frontend application
RUN npm install
RUN npm run build

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
