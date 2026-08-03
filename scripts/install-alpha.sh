#!/bin/sh
set -eu

VERSION="__VERSION__"
BASE_URL="__BASE_URL__"
ARM64_SHA256="__ARM64_SHA256__"
X64_SHA256="__X64_SHA256__"

fail() {
  printf 'trails alpha install: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  hub|join) mode=$1; shift ;;
  *) fail "usage: install.sh hub [--name NAME] | install.sh join URL [--name NAME]" ;;
esac

case "$(uname -s)" in
  Darwin) ;;
  *) fail "macOS is required" ;;
esac

case "$(uname -m)" in
  arm64)
    artifact="trails-darwin-arm64"
    expected_sha256=$ARM64_SHA256
    ;;
  x86_64)
    artifact="trails-darwin-x64"
    expected_sha256=$X64_SHA256
    ;;
  *) fail "unsupported Mac architecture: $(uname -m)" ;;
esac

case "$BASE_URL" in
  https://*/) ;;
  *) fail "release URL must use HTTPS and end in /" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v shasum >/dev/null 2>&1 || fail "shasum is required"

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/trails-alpha.XXXXXX")
staged_binary="$HOME/.local/bin/.trails.$$"
cleanup() {
  rm -rf "$temporary_directory"
  rm -f "$staged_binary"
}
trap cleanup EXIT HUP INT TERM

download="$temporary_directory/$artifact"
printf 'Downloading Trails %s for %s…\n' "$VERSION" "$(uname -m)"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  "$BASE_URL$artifact" --output "$download"

actual_sha256=$(shasum -a 256 "$download" | cut -d ' ' -f 1)
[ "$actual_sha256" = "$expected_sha256" ] || fail "download checksum did not match"

install -d -m 700 "$HOME/.local/bin"
install -m 700 "$download" "$staged_binary"
mv -f "$staged_binary" "$HOME/.local/bin/trails"

printf 'Installed Trails %s. Running setup…\n' "$VERSION"
"$HOME/.local/bin/trails" setup "$mode" "$@"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) printf '\nAdd this to your shell profile if `trails` is not found later:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
