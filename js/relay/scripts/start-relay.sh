#!/usr/bin/env bash
# Deploy the relay container from the published Docker image.
# Usage: bash start-relay.sh [--help]

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<USAGE
Usage: ${SCRIPT_NAME}

Environment:
  CONTAINER_NAME       Docker container name (default: hw1-relay)
  RELAY_IMAGE          Docker image tag (default: highway1net/relay:latest)
  PORT                 Relay WebSocket port inside container (default: 8080)
  HOST_PORT            Host port mapped to PORT (default: PORT)
  LANDING_PORT         Landing page port inside container, or false to disable (default: 8081)
  HOST_LANDING_PORT    Host port mapped to LANDING_PORT (default: 80)
  LOG_VOLUME           Docker volume for relay logs (default: hw1-logs)
  DATA_VOLUME          Docker volume for relay data (default: hw1-data)
  DATA_DIR             Relay data directory inside container (default: /data)
  PUBLIC_HOST          Public host/IP for display and PUBLIC_ENDPOINT inference
  PUBLIC_ENDPOINT      Advertised relay WebSocket URL (default: ws://<PUBLIC_HOST>:<HOST_PORT>)
  DEFAULT_SEED_RELAYS  Default seed relays used when SEED_RELAYS is unset
                       (default: ws://relay-sg-1.quadra-a.com:8080)
  SEED_RELAYS          Comma-separated seed relays; set to empty to disable
  PULL_IMAGE           true | false (default: true)
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" || "${1:-}" == "help" ]]; then
  usage
  exit 0
fi

CONTAINER_NAME="${CONTAINER_NAME:-hw1-relay}"
RELAY_IMAGE="${RELAY_IMAGE:-highway1net/relay:latest}"
PORT="${PORT:-8080}"
HOST_PORT="${HOST_PORT:-$PORT}"
LANDING_PORT="${LANDING_PORT:-8081}"
HOST_LANDING_PORT="${HOST_LANDING_PORT:-80}"
LOG_VOLUME="${LOG_VOLUME:-hw1-logs}"
DATA_VOLUME="${DATA_VOLUME:-hw1-data}"
DATA_DIR="${DATA_DIR:-/data}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
PUBLIC_ENDPOINT="${PUBLIC_ENDPOINT:-}"
DEFAULT_SEED_RELAYS="${DEFAULT_SEED_RELAYS:-ws://relay-sg-1.quadra-a.com:8080}"
PULL_IMAGE="${PULL_IMAGE:-true}"

if [[ "${SEED_RELAYS+x}" == "x" ]]; then
  SEED_RELAYS="$SEED_RELAYS"
else
  SEED_RELAYS="$DEFAULT_SEED_RELAYS"
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

resolve_public_host() {
  if [[ -n "$PUBLIC_HOST" ]]; then
    printf '%s' "$PUBLIC_HOST"
    return 0
  fi

  if command -v curl >/dev/null 2>&1; then
    curl -fsS ifconfig.me 2>/dev/null | tr -d '[:space:]' || true
  fi
}

is_false() {
  case "$1" in
    false|FALSE|False|0|no|NO|No)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

format_http_url() {
  local host="$1"
  local port="$2"

  if [[ "$port" == "80" ]]; then
    printf 'http://%s' "$host"
  else
    printf 'http://%s:%s' "$host" "$port"
  fi
}

pull_image() {
  if is_false "$PULL_IMAGE"; then
    echo "Skipping image pull (PULL_IMAGE=$PULL_IMAGE)..."
    return 0
  fi

  echo "Pulling latest image..."
  docker pull "$RELAY_IMAGE"
}

require_cmd docker

DISPLAY_HOST="$(resolve_public_host)"
if [[ -z "$DISPLAY_HOST" ]]; then
  DISPLAY_HOST="localhost"
fi

if [[ -z "$PUBLIC_ENDPOINT" ]]; then
  PUBLIC_ENDPOINT="ws://${DISPLAY_HOST}:${HOST_PORT}"
fi

PORT_ARGS=( -p "${HOST_PORT}:${PORT}" )
LANDING_DISPLAY="disabled"
ENV_ARGS=(
  -e "PORT=${PORT}"
  -e "DATA_DIR=${DATA_DIR}"
  -e "PUBLIC_ENDPOINT=${PUBLIC_ENDPOINT}"
)

if is_false "$LANDING_PORT"; then
  ENV_ARGS+=( -e "LANDING_PORT=false" )
else
  PORT_ARGS+=( -p "${HOST_LANDING_PORT}:${LANDING_PORT}" )
  ENV_ARGS+=( -e "LANDING_PORT=${LANDING_PORT}" )
  LANDING_DISPLAY="$(format_http_url "$DISPLAY_HOST" "$HOST_LANDING_PORT")"
fi

if [[ -n "$SEED_RELAYS" ]]; then
  ENV_ARGS+=( -e "SEED_RELAYS=${SEED_RELAYS}" )
fi

printf '=== Relay Deployment ===\n'
printf 'Container:      %s\n' "$CONTAINER_NAME"
printf 'Image:          %s\n' "$RELAY_IMAGE"
printf 'Relay endpoint: %s\n' "$PUBLIC_ENDPOINT"
printf 'Landing page:   %s\n' "$LANDING_DISPLAY"
if [[ -n "$SEED_RELAYS" ]]; then
  printf 'Seed relays:    %s\n' "$SEED_RELAYS"
else
  printf 'Seed relays:    disabled\n'
fi
printf '\n'

echo "Stopping old container..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

pull_image

echo "Starting relay..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  "${PORT_ARGS[@]}" \
  -v "$LOG_VOLUME:/app/logs" \
  -v "$DATA_VOLUME:${DATA_DIR}" \
  "${ENV_ARGS[@]}" \
  "$RELAY_IMAGE"

sleep 1
CONTAINER_STATUS="$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [[ "$CONTAINER_STATUS" != "running" ]]; then
  echo
  echo "Container failed to stay running (status: ${CONTAINER_STATUS:-unknown}). Recent logs:"
  docker logs --tail 80 "$CONTAINER_NAME" || true
  exit 1
fi

echo
echo "=== Deployment complete ==="
echo "WebSocket Relay: $PUBLIC_ENDPOINT"
echo "Landing Page:    $LANDING_DISPLAY"
echo "Logs:            docker logs -f $CONTAINER_NAME"
echo "Data volume:     $DATA_VOLUME"
echo "Log volume:      $LOG_VOLUME"
