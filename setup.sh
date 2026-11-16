#!/bin/sh
set -eu
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  if [ ! -d .venv ]; then uv venv .venv --python 3.12; fi
  uv pip sync --python .venv/bin/python requirements.txt
else
  if [ ! -d .venv ]; then python3 -m venv .venv; fi
  .venv/bin/python -m pip install -r requirements.txt
fi
.venv/bin/python setup_models.py
