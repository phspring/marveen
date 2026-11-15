#!/bin/bash
# The instance's own Claude home, shell side. Same rule as src/claude-home.ts (a parity test runs both):
#   1. NESTOR_CLAUDE_HOME in the environment   2. NESTOR_CLAUDE_HOME in <install>/.env   3. <install>/.claude-home
# It must never be the host user's ~/.claude, the home dir, or anything inside ~/.claude. Sourced, never executed;
# safe under `set -euo pipefail`.
#
#   claude_home_path <install dir>     prints the path (it may not exist yet); returns 2 on a forbidden value
#   claude_home_require <install dir>  prints the path only when it exists with its marker; else a message on stderr,
#                                      return 1 (no home) or 2 (forbidden). Callers refuse: no fallback to ~/.claude.

CLAUDE_HOME_MARKER=".nestor-claude-home"

_ch_real() {
  # realpath -m resolves what exists and keeps the rest (GNU); macOS has no -m, so fall back to the plain path.
  realpath -m -- "$1" 2>/dev/null || printf '%s' "$1"
}

_ch_env_value() {
  # The LAST NESTOR_CLAUDE_HOME= line of the .env, one pair of surrounding quotes stripped (as src/env-parse.ts).
  local file="$1" line val=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line//$'\r'/}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in NESTOR_CLAUDE_HOME=*) val="${line#NESTOR_CLAUDE_HOME=}" ;; esac
  done < "$file"
  val="${val%"${val##*[![:space:]]}"}"
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; \'*\') val="${val#\'}"; val="${val%\'}" ;; esac
  printf '%s' "$val"
}

claude_home_path() {
  local install="$1" raw home host
  raw="${NESTOR_CLAUDE_HOME:-}"
  [ -n "$raw" ] || raw="$(_ch_env_value "$install/.env")"
  [ -n "$raw" ] || raw="$install/.claude-home"
  case "$raw" in "~") raw="$HOME" ;; "~/"*) raw="$HOME/${raw#\~/}" ;; esac
  case "$raw" in /*) ;; *) echo "claude-home: NESTOR_CLAUDE_HOME must be an absolute path: $raw" >&2; return 2 ;; esac
  home="$(_ch_real "$raw")"
  host="$(_ch_real "$HOME/.claude")"
  if [ "$home" = "$host" ] || [ "$home" = "$(_ch_real "$HOME")" ] || [ "$home" = "$(_ch_real "$HOME/.claude.json")" ]; then
    echo "claude-home: NESTOR_CLAUDE_HOME must not be the host user's ~/.claude or home dir: $home" >&2; return 2
  fi
  case "$home/" in "$host"/*) echo "claude-home: NESTOR_CLAUDE_HOME must not be inside the host user's ~/.claude: $home" >&2; return 2 ;; esac
  printf '%s' "$home"
}

claude_home_require() {
  local home rc
  home="$(claude_home_path "$1")" || { rc=$?; return "$rc"; }
  if [ ! -d "$home" ] || [ ! -f "$home/$CLAUDE_HOME_MARKER" ]; then
    echo "claude-home: the instance has no own Claude home at $home; run \`nestor migrate-claude-home\`" >&2
    return 1
  fi
  printf '%s' "$home"
}
