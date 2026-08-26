#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd -- "$script_dir/.." && pwd)"
manifest="${T3_STACK_MANIFEST:-$backend_dir/t3-stack.lock}"

if [[ ! -f "$manifest" ]]; then
  echo "stack manifest not found: $manifest" >&2
  exit 2
fi

repo_count=0
name=""
path=""
rev=""

flush_repo() {
  [[ -z "$name$path$rev" ]] && return 0
  repo_count=$((repo_count + 1))
  if [[ -z "$name" || -z "$path" || -z "$rev" ]]; then
    echo "incomplete repo entry #$repo_count in $manifest" >&2
    exit 2
  fi

  local repo_dir
  repo_dir="$(cd -- "$backend_dir/$path" 2>/dev/null && pwd)" || {
    echo "missing stack repo $name at $path" >&2
    exit 2
  }
  local actual
  actual="$(git -C "$repo_dir" rev-parse HEAD)"
  if [[ "$rev" != "self" && "$actual" != "$rev" ]]; then
    echo "stack repo $name at $repo_dir is $actual, expected $rev" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
    echo "stack repo $name at $repo_dir is dirty" >&2
    git -C "$repo_dir" status --short >&2
    exit 1
  fi
  if [[ "$rev" == "self" ]]; then
    printf 'stack repo ok: %s %s (self)\n' "$name" "$actual"
  else
    printf 'stack repo ok: %s %s\n' "$name" "$rev"
  fi
  name=""
  path=""
  rev=""
}

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue
  if [[ "$line" == "[[repo]]" ]]; then
    flush_repo
    continue
  fi
  key="${line%%=*}"
  value="${line#*=}"
  key="${key%"${key##*[![:space:]]}"}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%\"}"
  value="${value#\"}"
  case "$key" in
    name) name="$value" ;;
    path) path="$value" ;;
    rev) rev="$value" ;;
  esac
done < "$manifest"
flush_repo

if [[ "$repo_count" -lt 7 ]]; then
  echo "stack manifest listed $repo_count repos, expected at least 7" >&2
  exit 2
fi

cd "$backend_dir"
exec cargo check --release --all-targets "$@"
