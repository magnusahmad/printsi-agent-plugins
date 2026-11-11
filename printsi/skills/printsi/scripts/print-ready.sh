#!/bin/sh
# Turn an HTML design into a print-ready PDF: exact trim size plus bleed on every side, CMYK colour, text converted to
# outlines, TrimBox and BleedBox set. Printers ask for exactly this.
#
#   print-ready.sh <design.html> <out.pdf> <trim-width-mm> <trim-height-mm> [bleed-mm]
#
# The HTML must draw a page of (trim + 2 × bleed) in each direction, e.g. for US Letter with 0.125 in (3.175 mm) bleed:
#   @page { size: 8.75in 11.25in; margin: 0 }   with backgrounds running to the page edge and text kept at least
#   (bleed + safe margin) from it.
#
# Needs Google Chrome or Chromium (rendering) and Ghostscript `gs` (CMYK and outlines). Runs locally; no network.
set -eu

if [ "$#" -lt 4 ]; then
  echo "usage: print-ready.sh <design.html> <out.pdf> <trim-width-mm> <trim-height-mm> [bleed-mm]" >&2
  exit 2
fi
html=$1
out=$2
trim_w=$3
trim_h=$4
bleed=${5:-3}

[ -f "$html" ] || { echo "No such file: $html" >&2; exit 2; }
command -v gs >/dev/null 2>&1 || { echo "Ghostscript (gs) is required: brew install ghostscript / apt install ghostscript" >&2; exit 3; }

chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    google-chrome google-chrome-stable chromium chromium-browser; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then chrome=$c; break; fi
  done
fi
[ -n "$chrome" ] || { echo "Google Chrome or Chromium is required (or set CHROME=/path/to/chrome)" >&2; exit 3; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
case $html in /*) abs=$html ;; *) abs=$(pwd)/$html ;; esac

# 1. Render at the CSS page size.
"$chrome" --headless=new --disable-gpu --no-pdf-header-footer --run-all-compositor-stages-before-draw \
  --virtual-time-budget=10000 --print-to-pdf="$tmp/rgb.pdf" "file://$abs" >/dev/null 2>&1
[ -s "$tmp/rgb.pdf" ] || { echo "Chrome produced no PDF" >&2; exit 4; }

# 2. Boxes in points (1 mm = 72/25.4 pt), written onto every page as it ends. (A `/PAGES pdfmark` would put them on
#    the page tree, where TrimBox isn't inherited, so printers would not see it.)
boxes=$(awk -v w="$trim_w" -v h="$trim_h" -v b="$bleed" 'BEGIN {
  k = 72 / 25.4; B = b * k; W = (w + 2 * b) * k; H = (h + 2 * b) * k
  printf "<< /EndPage { exch pop 0 eq { [/TrimBox [%.4f %.4f %.4f %.4f] /BleedBox [0 0 %.4f %.4f] /PAGE pdfmark true } { false } ifelse } bind >> setpagedevice", B, B, W - B, H - B, W, H
}')

# 3. CMYK, outlined text, boxes. The page-device setup must come before the input file.
gs -q -o "$out" -sDEVICE=pdfwrite -dNoOutputFonts \
  -sColorConversionStrategy=CMYK -sProcessColorModel=DeviceCMYK -dAutoRotatePages=/None \
  -c "$boxes" -f "$tmp/rgb.pdf"

echo "$out: trim ${trim_w}×${trim_h} mm, bleed ${bleed} mm, page $(awk -v w="$trim_w" -v h="$trim_h" -v b="$bleed" 'BEGIN{printf "%g×%g", w+2*b, h+2*b}') mm, CMYK, text outlined"
