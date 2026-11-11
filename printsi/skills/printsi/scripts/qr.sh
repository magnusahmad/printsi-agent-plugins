#!/bin/sh
# Make a print-sharp QR code as SVG (vector, scales to any size) for a flyer or poster.
#
#   qr.sh <url-or-text> <out.svg>
#
# Always dark modules on a white square with a 4-module quiet zone: inverted (light-on-dark) or low-contrast codes fail
# on many phone scanners, especially from a printed sheet on a wall. Place the SVG on its own white tile; print it at
# least 25 mm wide (30 mm+ if people will scan from a metre away). Error correction Q survives scuffs and glare.
#
# Uses segno (pure Python, pinned) through uv: `uvx` downloads it from PyPI on first use.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: qr.sh <url-or-text> <out.svg>" >&2
  exit 2
fi
command -v uvx >/dev/null 2>&1 || { echo "uv is required (https://docs.astral.sh/uv/): brew install uv" >&2; exit 3; }

uvx --quiet --from segno==1.6.6 segno "$1" --error=q --border=4 --dark="#000000" --light="#ffffff" \
  --no-size --no-xmldecl --output="$2"
echo "$2: QR for $1 (vector; place on white, at least 25 mm wide)"
