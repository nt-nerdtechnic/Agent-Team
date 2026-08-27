"""Knock the white studio plate out of the Navide source render.

Pixel thresholds alone cannot separate the mark's pale cyan facets from the
pale cyan glow spilling onto the plate around it — they occupy the same
luma/saturation range. So the mark's extent is decided spatially: close the
saturated skeleton into a solid silhouette, and treat everything outside it as
plate, where alpha comes from how far the pixel is from white.
"""
import os
import numpy as np
from collections import deque
from PIL import Image, ImageFilter

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "import", "source-plate.png")
WORD_TOP = 855          # empty row band at y 844-863 splits mark from wordmark


def _spans(cand, seeds):
    h, w = cand.shape
    filled = np.zeros_like(cand)
    stack = deque(seeds)
    while stack:
        y, x = stack.pop()
        if filled[y, x] or not cand[y, x]:
            continue
        row, frow = cand[y], filled[y]
        x1 = x
        while x1 > 0 and row[x1-1] and not frow[x1-1]:
            x1 -= 1
        x2 = x
        while x2 < w-1 and row[x2+1] and not frow[x2+1]:
            x2 += 1
        frow[x1:x2+1] = True
        for ny in (y-1, y+1):
            if 0 <= ny < h:
                seg = cand[ny, x1:x2+1] & ~filled[ny, x1:x2+1]
                idx = np.flatnonzero(seg)
                if idx.size:
                    for s in idx[np.r_[True, np.diff(idx) > 1]]:
                        stack.append((ny, x1 + int(s)))
    return filled


def flood_from_border(cand):
    h, w = cand.shape
    seeds = [(0, x) for x in range(w) if cand[0, x]]
    seeds += [(h-1, x) for x in range(w) if cand[h-1, x]]
    seeds += [(y, 0) for y in range(h) if cand[y, 0]]
    seeds += [(y, w-1) for y in range(h) if cand[y, w-1]]
    return _spans(cand, seeds)


def _morph(mask, filt, size, times):
    img = Image.fromarray((mask*255).astype(np.uint8), "L")
    for _ in range(times):
        img = img.filter(filt(size))
    return np.asarray(img) > 127


def close(mask, size=9, times=3):
    return _morph(_morph(mask, ImageFilter.MaxFilter, size, times),
                  ImageFilter.MinFilter, size, times)


def fill_holes(mask):
    return ~flood_from_border(~mask)


def smooth(mask, radius=1.2):
    """Blur-then-rethreshold, to file the jaggies off a thresholded silhouette."""
    img = Image.fromarray((mask*255).astype(np.uint8), "L").filter(
        ImageFilter.GaussianBlur(radius))
    return np.asarray(img) > 127


def blur(mask_or_arr, radius):
    a = mask_or_arr.astype(np.float32)
    if a.max() <= 1.0:
        a = a * 255.0
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L")
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32)


def cutout(src=SRC):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    luma = 0.2126*a[..., 0] + 0.7152*a[..., 1] + 0.0722*a[..., 2]
    sat = a.max(axis=2) - a.min(axis=2)

    band = np.zeros(luma.shape, bool)
    band[:WORD_TOP] = True

    # The mark: its facets run sat ~150-165, while the blue glow the render
    # spills onto the plate sits at sat ~85-120 — mid-brightness, not pale, so
    # no luma test separates them (capping luma at 200 changes the outline not
    # at all). 105 is the seam: below it the glow beside the left foot joins
    # the body and shows up as a pale wedge; above ~125 the mark's own softer
    # facets start dropping out and the silhouette breaks open.
    skeleton = band & (sat > 105)
    # Keep closing minimal. At 9x3 (a 12px dilate) it seals the narrow notch
    # where the two legs meet, trapping the white plate above the V as a pale
    # blob no later stage can reach — the border flood cannot get into a pocket
    # that is walled off, and punching it out by hand leaves the edge stippled.
    # 5x1 still bridges the skeleton's hairline breaks; the silhouette differs
    # by 0.05%, and the notch stays open.
    mark = smooth(fill_holes(close(skeleton, 5, 1)))
    # closing seals the narrow seam between the N's legs, trapping a sliver of
    # the white plate inside the silhouette; punch it back out
    mark &= ~(mark & (luma > 250) & (sat < 12))

    # the wordmark: near-black letterforms plus the saturated dot over the "i".
    # No hole filling here — the counters in a, d and e must stay open.
    word = close((~band) & ((luma < 150) | (sat > 60)), 5, 1)

    # The mark is an opaque light-coloured object, so "distance from white"
    # is NOT its alpha — it would read a pale lilac edge as half transparent
    # and leave the silhouette looking chewed. Feather it geometrically
    # instead, dilated by a pixel to recover the anti-aliased rim the
    # threshold cuts off.
    white_a = np.clip(255.0 - luma, 0, 255)
    # Feathering alone hands alpha to the plate pixels just outside the
    # silhouette, and those are pure white — un-premultiplying cannot recover a
    # colour that was never there, so they survive as half-transparent white
    # specks along the edge. What disqualifies them is not being white but
    # being reachable from outside: the mark's own white highlight ridges are
    # walled in by its facets, while the plate runs to the image border.
    # (Capping the feather by whiteness instead also erases those ridges, which
    # then read as a dashed black seam across the upper-left facet.)
    plate = flood_from_border((luma > 232) & (sat < 45))
    mark_a = np.where(mark, 255.0,
                      blur(_morph(mark, ImageFilter.MaxFilter, 3, 1), 1.0))
    mark_a[plate] = 0.0

    # The wordmark IS near-black on white, so whiteness is the correct matte
    # there — but only in a thin rim, so the drop shadow does not come with it.
    rim = _morph(word, ImageFilter.MaxFilter, 3, 2) & ~word
    word_a = blur(np.where(word, 255.0, np.where(rim, white_a, 0.0)), 0.6)

    alpha = np.clip(np.maximum(mark_a, word_a), 0, 255)

    # un-premultiply against the white plate so no edge keeps a pale fringe
    rgb = a.copy()
    m = (alpha > 0.5) & (alpha < 254.5)
    af = (alpha[m] / 255.0)[:, None]
    rgb[m] = np.clip((a[m] - 255.0*(1.0 - af)) / af, 0, 255)

    return Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA"), (mark | word), alpha


if __name__ == "__main__":
    import sys
    img, fg, alpha = cutout()
    img.save(sys.argv[1])
    a = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float32)
    luma = 0.2126*a[..., 0]+0.7152*a[..., 1]+0.0722*a[..., 2]
    print(f"foreground {fg.mean()*100:.1f}%")
    print(f"light opaque leftovers: {((alpha > 200) & (luma > 232) & ~fg).sum():,} px outside the silhouette")
    print(f"haze inside silhouette (kept, part of the mark): {((alpha > 200) & (luma > 232) & fg).sum():,} px")
    op = alpha > 12
    ys, xs = np.where(op)
    print(f"opaque bbox x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()}")
    for lbl, sl in [("mark", slice(0, WORD_TOP)), ("word", slice(WORD_TOP, 1254))]:
        seg = op[sl]
        cy = np.flatnonzero(seg.any(axis=1)); cx = np.flatnonzero(seg.any(axis=0))
        off = sl.start
        print(f"  {lbl}: x {cx.min()}-{cx.max()} y {cy.min()+off}-{cy.max()+off}")
