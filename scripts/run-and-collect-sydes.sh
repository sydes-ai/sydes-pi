#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/Projects/sydes-pi"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HOME/Desktop/sydes-live-${STAMP}.txt"

{
  echo "=== Sydes Live Run ==="
  echo "timestamp_utc=$STAMP"
  echo "cwd=$(pwd)"
  echo "node=$(node -v)"
  echo "pi=$(./node_modules/.bin/pi --version 2>/dev/null || true)"
  echo "cbm=$(./node_modules/.bin/codebase-memory-mcp --version 2>/dev/null || true)"
  echo "openai_key=$([[ -n "${OPENAI_API_KEY:-}" ]] && echo SET || echo MISSING)"
  echo

  echo "=== Running Sydes ==="

  # The Phase 3.2 runner should itself:
  # - create the fresh worktree
  # - pre-test
  # - ensure CBM readiness
  # - abort if context is empty
  # - run exactly one Pi task
  # - run repo tests + hidden oracle
  # - analyze the Pi session
  #
  # Capture its normal compact stdout/stderr here.
  npm run live:sydes -- --confirm-paid-run

  echo
  echo "=== Latest Run Artifacts ==="

  LATEST_RUN="$(find "$HOME/.sydes-pi/runs/pokemon-api" \
    -mindepth 1 -maxdepth 1 -type d \
    -print 2>/dev/null | sort | tail -1)"

  if [[ -z "${LATEST_RUN:-}" ]]; then
    echo "ERROR: no Sydes run directory found"
    exit 1
  fi

  echo "run_dir=$LATEST_RUN"
  echo

  print_file () {
    local title="$1"
    local file="$2"

    echo "===== $title ====="
    if [[ -f "$file" ]]; then
      cat "$file"
    else
      echo "[missing: $file]"
    fi
    echo
  }

  print_file "run.json" "$LATEST_RUN/run.json"
  print_file "sydes.json" "$LATEST_RUN/sydes.json"
  print_file "summary.json" "$LATEST_RUN/summary.json"
  print_file "repo-tests.txt" "$LATEST_RUN/repo-tests.txt"
  print_file "hidden-oracle.txt" "$LATEST_RUN/hidden-oracle.txt"

  echo "===== final.diff ====="
  if [[ -f "$LATEST_RUN/final.diff" ]]; then
    cat "$LATEST_RUN/final.diff"
  else
    echo "[missing final.diff]"
  fi
  echo

  echo "=== Relevant Pi Session Extract ==="

  SESSION_PATH="$(
    node - "$LATEST_RUN/run.json" <<'NODE'
const fs = require("fs");
const p = process.argv[2];
try {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  process.stdout.write(j.piSessionPath || "");
} catch {}
NODE
  )"

  echo "pi_session=$SESSION_PATH"

  if [[ -n "$SESSION_PATH" && -f "$SESSION_PATH" ]]; then
    echo
    echo "===== Pi session compact extract ====="

    node - "$SESSION_PATH" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);

for (const line of lines) {
  let x;
  try { x = JSON.parse(line); } catch { continue; }

  // Keep only information useful for trajectory debugging.
  const out = {};

  if (x.type !== undefined) out.type = x.type;
  if (x.timestamp !== undefined) out.timestamp = x.timestamp;

  const msg = x.message || x;
  if (msg.role !== undefined) out.role = msg.role;
  if (msg.model !== undefined) out.model = msg.model;
  if (msg.provider !== undefined) out.provider = msg.provider;
  if (msg.stopReason !== undefined) out.stopReason = msg.stopReason;
  if (msg.usage !== undefined) out.usage = msg.usage;

  if (msg.toolCallId !== undefined) out.toolCallId = msg.toolCallId;
  if (msg.toolName !== undefined) out.toolName = msg.toolName;
  if (msg.isError !== undefined) out.isError = msg.isError;

  if (msg.content !== undefined) {
    const content = msg.content;

    if (typeof content === "string") {
      out.content = content.length > 3000
        ? content.slice(0, 3000) + "...[truncated]"
        : content;
    } else if (Array.isArray(content)) {
      out.content = content.map(part => {
        if (!part || typeof part !== "object") return part;

        const q = {};
        for (const k of [
          "type",
          "text",
          "toolCallId",
          "toolName",
          "name",
          "arguments",
          "input",
          "isError"
        ]) {
          if (part[k] !== undefined) q[k] = part[k];
        }

        if (typeof q.text === "string" && q.text.length > 3000) {
          q.text = q.text.slice(0, 3000) + "...[truncated]";
        }
        return q;
      });
    }
  }

  // Skip records that carry no useful trajectory information.
  if (Object.keys(out).length > 2 ||
      out.role ||
      out.toolName ||
      out.usage) {
    console.log(JSON.stringify(out));
  }
}
NODE
  else
    echo "[Pi session unavailable]"
  fi

  echo
  echo "=== Git State ==="
  git status --short
  echo
  echo "=== End Sydes Live Run ==="

} 2>&1 | tee "$OUT"

echo
echo "Saved shareable output to:"
echo "$OUT"
