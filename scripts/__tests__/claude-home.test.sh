#!/bin/bash
# scripts/lib/claude-home.sh: where an instance's own Claude home is, what it may never be, and that a launcher
# refuses without one. The same cases run through src/claude-home.ts (node) so the two resolvers cannot drift.
# Run: bash scripts/__tests__/claude-home.test.sh

set -u
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/host"
mkdir -p "$HOME/.claude" "$T/install"
unset NESTOR_CLAUDE_HOME
. "$REPO/scripts/lib/claude-home.sh"

expect_path() { # name, expected, [env value]
  local got
  if [ -n "${3:-}" ]; then got="$(NESTOR_CLAUDE_HOME="$3" claude_home_path "$T/install" 2>/dev/null)"; else got="$(claude_home_path "$T/install" 2>/dev/null)"; fi
  [ "$got" = "$2" ] && pass "$1" || fail "$1 (got '$got', want '$2')"
}
expect_refused() { # name, env value
  if NESTOR_CLAUDE_HOME="$2" claude_home_path "$T/install" >/dev/null 2>&1; then fail "$1 accepted"; else pass "$1 refused"; fi
}

echo "claude-home.sh"
expect_path "default is <install>/.claude-home" "$T/install/.claude-home"
printf 'NESTOR_CLAUDE_HOME="%s"\n' "$T/from-dotenv" > "$T/install/.env"
expect_path ".env value wins over the default" "$T/from-dotenv"
expect_path "environment wins over .env" "$T/from-env" "$T/from-env"
rm -f "$T/install/.env"
expect_refused "the host ~/.claude" "$HOME/.claude"
expect_refused "inside the host ~/.claude" "$HOME/.claude/sub"
expect_refused "the home dir itself" "$HOME"
expect_refused "~/.claude spelled with a tilde" "~/.claude"
expect_refused "a relative path" "relative/home"
ln -s "$HOME/.claude" "$T/sneaky"
expect_refused "a link into the host ~/.claude" "$T/sneaky"

# require: no dir -> 1, dir without marker -> 1, marked dir -> its path
if claude_home_require "$T/install" >/dev/null 2>&1; then fail "require without a home"; else pass "require without a home refuses"; fi
mkdir -p "$T/install/.claude-home"
if claude_home_require "$T/install" >/dev/null 2>&1; then fail "require without the marker"; else pass "require without the marker refuses"; fi
echo '{}' > "$T/install/.claude-home/$CLAUDE_HOME_MARKER"
got="$(claude_home_require "$T/install")" && [ "$got" = "$T/install/.claude-home" ] && pass "require with the marker" || fail "require with the marker (got '$got')"

# parity with src/claude-home.ts: the same inputs, the same verdict (path or refusal)
NODE="$(command -v node || true)"
if [ -n "$NODE" ] && "$NODE" -e 'process.exit(0)' 2>/dev/null && [ -x "$REPO/node_modules/.bin/tsx" ]; then
  for v in "" "$T/abs-home" "$HOME/.claude" "$HOME/.claude/x" "$HOME" "relative/x" "$T/sneaky"; do
    sh_out="$(NESTOR_CLAUDE_HOME="$v" claude_home_path "$T/install" 2>/dev/null || echo REFUSED)"
    ts_out="$(cd "$REPO" && NESTOR_CLAUDE_HOME="$v" HOME="$HOME" "$REPO/node_modules/.bin/tsx" -e "
      import('./src/claude-home.ts').then((m) => { try { process.stdout.write(m.instanceClaudeHome(process.argv[1])) } catch { process.stdout.write('REFUSED') } })
    " "$T/install" 2>/dev/null)"
    [ "$sh_out" = "$ts_out" ] && pass "parity for '${v:-<unset>}'" || fail "parity for '${v:-<unset>}': sh='$sh_out' ts='$ts_out'"
  done
else
  echo "  SKIP: parity (no usable node / tsx)"
fi

echo ""
echo "Results: $PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ]
