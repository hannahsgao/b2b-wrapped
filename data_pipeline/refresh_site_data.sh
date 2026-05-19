#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPELINE_DIR="$ROOT_DIR/data_pipeline"
RAW_DIR="$PIPELINE_DIR/raw"
SITE_DATA_DIR="$ROOT_DIR/site/data"
PYTHON_BIN="${PYTHON:-$ROOT_DIR/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

mkdir -p "$RAW_DIR" "$SITE_DATA_DIR"

unset PLAYWRIGHT_BROWSERS_PATH

"$PYTHON_BIN" "$PIPELINE_DIR/scripts/scrape_laurelt.py" --out "$RAW_DIR" "$@"
"$PYTHON_BIN" "$PIPELINE_DIR/scripts/derive_site_data.py" \
  --results "$RAW_DIR/b2b_2026_results_raw.csv" \
  --teams "$RAW_DIR/b2b_2026_teams_raw.csv" \
  --out "$SITE_DATA_DIR" \
  --privacy initials
