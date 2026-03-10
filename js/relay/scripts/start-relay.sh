#!/usr/bin/env bash
# Deploy Highway 1 Relay to production server
# Usage: bash bootstrap.sh

set -euo pipefail

echo "=== Highway 1 Relay Deployment ==="
echo ""

# Stop and remove old container
echo "Stopping old container..."
docker stop hw1-relay 2>/dev/null || true
docker rm hw1-relay 2>/dev/null || true

# Pull latest image
echo "Pulling latest image..."
docker pull highway1net/relay:latest

PUBLIC_HOST="${PUBLIC_HOST:-}"

if [[ -z "${PUBLIC_HOST}" ]]; then
  if command -v curl >/dev/null 2>&1; then
    PUBLIC_HOST="$(curl -s ifconfig.me)"
  fi
fi

PORT="${PORT:-8080}"
PUBLIC_ENDPOINT="${PUBLIC_ENDPOINT:-ws://${PUBLIC_HOST}:${PORT}}"

# Start new container
echo "Starting relay..."
docker run -d \
  --name hw1-relay \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 80:8081 \
  -v hw1-logs:/app/logs \
  -v hw1-data:/data \
  -e DATA_DIR=/data \
  -e PUBLIC_ENDPOINT="${PUBLIC_ENDPOINT}" \
  -e SEED_RELAYS=ws://relay-sg-1.quadra-a.com:8080 \
  highway1net/relay:latest

echo ""
echo "=== Deployment complete! ==="
echo ""
echo "WebSocket Relay: ws://$(curl -s ifconfig.me):8080"
echo "Landing Page:    http://$(curl -s ifconfig.me)"
echo ""
echo "Check logs with: docker logs -f hw1-relay"
