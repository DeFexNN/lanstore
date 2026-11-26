#!/usr/bin/env bash
# lanstore one-command installer for Linux/macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/DeFexNN/lanstore/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --agent my-pc --token "$LANSTORE_TOKEN"
#
# Works both from a git checkout (uses the local files) and piped (clones the repo).
set -euo pipefail

REPO="${LANSTORE_REPO:-https://github.com/DeFexNN/lanstore.git}"
APP_DIR="${LANSTORE_APP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/lanstore}"

have_node() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

self="${BASH_SOURCE[0]:-}"
here=""
if [ -n "$self" ] && [ -f "$self" ]; then
  here="$(cd "$(dirname "$self")" && pwd)"
fi

if [ -n "$here" ] && [ -f "$here/src/installer.mjs" ]; then
  APP_DIR="$here"
else
  echo "==> lanstore: завантажую в $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  if command -v git >/dev/null 2>&1; then
    if [ -d "$APP_DIR/.git" ]; then
      git -C "$APP_DIR" fetch --depth 1 origin main >/dev/null 2>&1 || true
      git -C "$APP_DIR" reset --hard origin/main >/dev/null 2>&1 || true
    else
      rm -rf "$APP_DIR"
      git clone --depth 1 "$REPO" "$APP_DIR"
    fi
  elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "${REPO%.git}/archive/refs/heads/main.tar.gz" -o "$tmp/src.tgz"
    tar -xzf "$tmp/src.tgz" -C "$tmp"
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    cp -R "$tmp"/*/. "$APP_DIR"/
  else
    echo "❌ Потрібен git або curl+tar, щоб завантажити lanstore." >&2
    exit 1
  fi
fi

if ! have_node; then
  echo "❌ Потрібен Node.js 20+ (node не знайдено або версія старіша)." >&2
  echo "   Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  echo "   Fedora:        sudo dnf install -y nodejs" >&2
  echo "   або:           https://nodejs.org/en/download" >&2
  echo "   Після встановлення повторіть цю саму команду — вона продовжить з того ж місця." >&2
  exit 1
fi

exec node "$APP_DIR/src/installer.mjs" "$@"
