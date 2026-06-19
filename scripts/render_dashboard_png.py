#!/usr/bin/env python3
"""Render the demo dashboard HTML to docs/dashboard.png (the README hero).

Pipeline (headless, no browser): weasyprint renders the self-contained HTML to PDF in PRINT media — so
the @media print rules apply and the interactive sync/ask/buttons auto-hide — on a tall single page so
the top cards aren't paginated mid-way; then pymupdf rasterises page 1 at 2x and the bottom cream margin
is trimmed to a clean hero crop (Today + load/trends + top insights + a card or two).

Usage:  python3 scripts/render_dashboard_png.py reports/demo-dashboard.html docs/dashboard.png
"""
import sys
import weasyprint
import fitz  # pymupdf

HTML = sys.argv[1] if len(sys.argv) > 1 else "reports/demo-dashboard.html"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/dashboard.png"
ZOOM = 2  # 2x for a crisp retina-ish image

# Tall single page so the hero cards land on page 1; cards use break-inside:avoid so none is cut.
page_css = weasyprint.CSS(string="@page { size: 860px 2000px; margin: 0; } body { padding: 18px !important; max-width: 100% !important; }")
pdf_bytes = weasyprint.HTML(filename=HTML).write_pdf(stylesheets=[page_css])

doc = fitz.open(stream=pdf_bytes, filetype="pdf")
page = doc[0]
pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False)

# Find the content bottom: scan rows from the bottom for the first that isn't the (cream) background.
w, h, n = pix.width, pix.height, pix.n
buf = pix.samples
bg = (buf[0], buf[1], buf[2])  # top-left pixel = page background


def row_is_bg(y: int) -> bool:
    base = y * w * n
    for x in range(0, w, 3):  # step for speed
        o = base + x * n
        if abs(buf[o] - bg[0]) > 6 or abs(buf[o + 1] - bg[1]) > 6 or abs(buf[o + 2] - bg[2]) > 6:
            return False
    return True


bottom = h
while bottom > 1 and row_is_bg(bottom - 1):
    bottom -= 1
bottom = min(h, bottom + 18 * ZOOM)  # keep a small cream margin below the last card

content_pt = bottom / ZOOM
clip = fitz.Rect(0, 0, page.rect.width, content_pt)
cropped = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False, clip=clip)
cropped.save(OUT)
print(f"wrote {OUT}  ({cropped.width}x{cropped.height})")
