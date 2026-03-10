#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT_DIR/package.json').version")}" 
IMAGE_REPO="${IMAGE_REPO:-highway1net/relay}"
EXTRA_IMAGE_REPOS="${EXTRA_IMAGE_REPOS:-}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER_NAME="${BUILDER_NAME:-relay-multiarch}"
BUILD_PROVENANCE="${BUILD_PROVENANCE:-false}"
DRY_RUN="${DRY_RUN:-}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

collect_image_repos() {
  local raw="${IMAGE_REPO}"
  if [[ -n "$EXTRA_IMAGE_REPOS" ]]; then
    raw+=",${EXTRA_IMAGE_REPOS}"
  fi

  local -a parsed=()
  IFS=',' read -r -a parsed <<< "$raw"

  IMAGE_REPOS=()
  for repo in "${parsed[@]}"; do
    repo="$(trim "$repo")"
    if [[ -n "$repo" ]]; then
      IMAGE_REPOS+=("$repo")
    fi
  done

  if [[ ${#IMAGE_REPOS[@]} -eq 0 ]]; then
    echo "Error: no image repositories configured"
    exit 1
  fi
}

ensure_builder() {
  if ! docker buildx version >/dev/null 2>&1; then
    echo "Error: docker buildx is required for multi-platform publishing"
    exit 1
  fi

  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    echo "Creating buildx builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --use >/dev/null
  else
    docker buildx use "$BUILDER_NAME" >/dev/null
  fi

  docker buildx inspect --bootstrap >/dev/null
}

cd "$ROOT_DIR"
collect_image_repos

declare -a TAG_ARGS=()
declare -a PUBLISHED_TAGS=()
for repo in "${IMAGE_REPOS[@]}"; do
  TAG_ARGS+=( -t "$repo:$VERSION" -t "$repo:latest" )
  PUBLISHED_TAGS+=( "$repo:$VERSION" "$repo:latest" )
done

if [[ -n "$DRY_RUN" ]]; then
  echo "[DRY RUN] Would build and push multi-platform relay image"
  echo "[DRY RUN] Platforms: $PLATFORMS"
  printf '[DRY RUN] Tags:\n'
  printf '  %s\n' "${PUBLISHED_TAGS[@]}"
  exit 0
fi

echo "Installing relay dependencies..."
pnpm install --no-frozen-lockfile

echo "Building relay package..."
pnpm build

echo "Preparing Docker buildx builder..."
ensure_builder

echo "Building and pushing multi-platform Docker image..."
docker buildx build \
  --platform "$PLATFORMS" \
  --provenance "$BUILD_PROVENANCE" \
  "${TAG_ARGS[@]}" \
  --push \
  .

echo "Published multi-platform images:"
printf '  %s\n' "${PUBLISHED_TAGS[@]}"
