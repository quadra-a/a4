#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_dir="$repo_dir"
if [[ -f "$repo_dir/../Cargo.toml" ]] && grep -q '^\[workspace\]' "$repo_dir/../Cargo.toml"; then
  workspace_dir="$(cd "$repo_dir/.." && pwd)"
fi
cargo_toml="$repo_dir/Cargo.toml"
out_dir="$repo_dir/release-assets"
target_triple=""
binary_path=""
os_name=""
arch_name=""
version=""

usage() {
  cat <<USAGE
Usage: scripts/package-release.sh [options]

Options:
  --target <triple>   Package target/<triple>/release/a4
  --binary <path>     Package an explicit binary path
  --os <name>         Override OS segment in archive name
  --arch <name>       Override arch segment in archive name
  --version <value>   Override version segment in archive name
  --out-dir <path>    Output directory for the archive
  --help              Show this help
USAGE
}

normalize_os() {
  case "$1" in
    darwin|macos|mac|osx) printf 'macos' ;;
    linux) printf 'linux' ;;
    windows|win32|mingw*|msys*|cygwin*) printf 'windows' ;;
    *) printf '%s' "$1" ;;
  esac
}

normalize_arch() {
  case "$1" in
    arm64|aarch64) printf 'aarch64' ;;
    amd64|x86_64) printf 'x86_64' ;;
    *) printf '%s' "$1" ;;
  esac
}

infer_from_target() {
  case "$1" in
    aarch64-apple-darwin) os_name='macos'; arch_name='aarch64' ;;
    x86_64-apple-darwin) os_name='macos'; arch_name='x86_64' ;;
    aarch64-unknown-linux-musl|aarch64-unknown-linux-gnu) os_name='linux'; arch_name='aarch64' ;;
    x86_64-unknown-linux-musl|x86_64-unknown-linux-gnu) os_name='linux'; arch_name='x86_64' ;;
    x86_64-pc-windows-gnu|x86_64-pc-windows-msvc) os_name='windows'; arch_name='x86_64' ;;
    aarch64-pc-windows-msvc) os_name='windows'; arch_name='aarch64' ;;
    *)
      arch_name="$(normalize_arch "${1%%-*}")"
      case "$1" in
        *apple-darwin) os_name='macos' ;;
        *linux*) os_name='linux' ;;
        *windows*) os_name='windows' ;;
      esac
      ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      target_triple="$2"
      shift 2
      ;;
    --binary)
      binary_path="$2"
      shift 2
      ;;
    --os)
      os_name="$(normalize_os "$2")"
      shift 2
      ;;
    --arch)
      arch_name="$(normalize_arch "$2")"
      shift 2
      ;;
    --version)
      version="$2"
      shift 2
      ;;
    --out-dir)
      out_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$version" ]; then
  version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$cargo_toml" | head -n 1)"
fi

if [ -z "$version" ]; then
  echo 'Failed to read version from Cargo.toml' >&2
  exit 1
fi

if [ -z "$binary_path" ]; then
  if [ -n "$target_triple" ]; then
    binary_path="$workspace_dir/target/$target_triple/release/a4"
    case "$target_triple" in
      *windows*) binary_path+='.exe' ;;
    esac
  else
    binary_path="$workspace_dir/target/release/a4"
  fi
fi

if [ ! -f "$binary_path" ]; then
  echo "Binary not found: $binary_path" >&2
  exit 1
fi

if [ -n "$target_triple" ] && { [ -z "$os_name" ] || [ -z "$arch_name" ]; }; then
  infer_from_target "$target_triple"
fi

if [ -z "$os_name" ]; then
  os_name="$(normalize_os "$(uname -s | tr '[:upper:]' '[:lower:]')")"
fi

if [ -z "$arch_name" ]; then
  arch_name="$(normalize_arch "$(uname -m | tr '[:upper:]' '[:lower:]')")"
fi

mkdir -p "$out_dir"
archive_name="a4-${os_name}-${arch_name}-v${version}.tar.gz"
archive_path="$out_dir/$archive_name"

tar -C "$(dirname "$binary_path")" -czf "$archive_path" "$(basename "$binary_path")"
printf '%s\n' "$archive_path"
