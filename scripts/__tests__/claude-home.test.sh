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

# macOS: its realpath has no -m (Copilot on #18). With such a realpath first on PATH a link into the host must still be
# refused, and a not-yet-existing home under a linked parent must still resolve through the link.
mkdir -p "$T/bsd-bin"
cat > "$T/bsd-bin/realpath" <<'EOF_RP'
#!/bin/bash
for a in "$@"; do case "$a" in -m|-e|-s|--*) echo "realpath: illegal option -- ${a#-}" >&2; exit 1 ;; esac; done
exec /usr/bin/realpath "$@"
EOF_RP
chmod +x "$T/bsd-bin/realpath"
if PATH="$T/bsd-bin:$PATH" NESTOR_CLAUDE_HOME="$T/sneaky" claude_home_path "$T/install" >/dev/null 2>&1; then fail "no realpath -m: a link into the host accepted"; else pass "no realpath -m: a link into the host refused"; fi
if PATH="$T/bsd-bin:$PATH" NESTOR_CLAUDE_HOME="$T/sneaky/new-sub" claude_home_path "$T/install" >/dev/null 2>&1; then fail "no realpath -m: a new dir under a link into the host accepted"; else pass "no realpath -m: a new dir under a link into the host refused"; fi
got="$(PATH="$T/bsd-bin:$PATH" NESTOR_CLAUDE_HOME="$T/plain/new-home" claude_home_path "$T/install" 2>/dev/null)"
[ "$got" = "$T/plain/new-home" ] && pass "no realpath -m: a plain new home resolves" || fail "no realpath -m: a plain new home (got '$got')"

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
