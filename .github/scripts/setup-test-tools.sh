#!/usr/bin/env bash
# Installs the external tools the integration tests need. The shared CI
# workflow runs this script when it exists.
set -euo pipefail

case "$(uname -s)" in
  Linux)
    command -v tmux >/dev/null || { sudo apt-get update && sudo apt-get install --yes tmux; }
    # Ubuntu 24.04 ships tmux 3.4, a version the README lists as tested.
    tmux -V | grep -Fx "tmux 3.4"
    ;;
  Darwin)
    command -v tmux >/dev/null || brew install tmux
    tmux -V
    ;;
  *)
    echo "No tmux on this platform; tmux integration tests skip."
    ;;
esac
