#!/usr/bin/env bash
# Render /resume/ to public/pdfs/resume/adam-manning-resume.pdf with headless
# Chrome. Run after editing the résumé or adding projects (selected credits
# are pulled from the project collection): npm run resume:pdf
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-4391}"
OUT=public/pdfs/resume/adam-manning-resume.pdf

npm run build >/dev/null
npx astro preview --port "$PORT" >/dev/null 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -sf "http://localhost:$PORT/portfolio/resume/" >/dev/null && break
  sleep 0.2
done

"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=5000 \
  --print-to-pdf="$OUT" "http://localhost:$PORT/portfolio/resume/" 2>/dev/null
echo "wrote $OUT"
