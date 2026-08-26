#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
manifest="$script_dir/../Cargo.toml"

exec cargo test --manifest-path "$manifest" --no-fail-fast "$@"
