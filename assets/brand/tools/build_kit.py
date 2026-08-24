"""Render the whole Navide logo kit from the cut-out source lockup."""
import base64, io, os, sys
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cutout import cutout, WORD_TOP

DST = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DARK = (13, 17, 23, 255)          # #0d1117, the Navide window background
WHITE = (255, 255, 255, 255)


def trim(img, thresh=8):
    a = np.asarray(img)[..., 3]
    ys, xs = np.where(a > thresh)
    return img.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))


def bleed(img, iters=24):
    """Push edge colour outwards into the transparent region.

    PNG carries colour un-premultiplied, and every transparent pixel here still
    holds the source plate's white. PIL resamples RGB and alpha independently,
    so that white bleeds into the mark's outline as half-transparent specks —
    which is what showed along the app icon's edge. Premultiplying instead is
    worse: un-premultiplying afterwards divides by a near-zero alpha and blows
    those pixels out to white. Flooding the colour outwards first means that
    whatever the resampler drags inward is the mark's own colour.
    """
    a = np.asarray(img).astype(np.float32)
    rgb, al = a[..., :3].copy(), a[..., 3]
    known = al > 8
    for _ in range(iters):
        if known.all():
            break
        num = np.zeros_like(rgb)
        den = np.zeros(known.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(known, (dy, dx), (0, 1)).astype(np.float32)
            num += np.roll(rgb, (dy, dx), (0, 1)) * k[..., None]
            den += k
        new = ~known & (den > 0)
        rgb[new] = num[new] / den[new][..., None]
        known |= new
    return Image.fromarray(np.dstack([rgb, al]).astype(np.uint8), "RGBA")


def fit(img, box_w, box_h):
    """Scale to fit inside the box, preserving aspect."""
    w, h = img.size
    s = min(box_w/w, box_h/h)
    return img.resize((max(1, round(w*s)), max(1, round(h*s))), Image.LANCZOS)


def canvas(size, bg=None, radius=None):
    w, h = size if isinstance(size, tuple) else (size, size)
    if bg is None:
        return Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if radius is None:
        return Image.new("RGBA", (w, h), bg)
    c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(c).rounded_rectangle([0, 0, w-1, h-1], radius=radius, fill=bg)
    return c


def compose(content, size, ratio=0.86, bg=None, radius=None, offset=(0, 0)):
    c = canvas(size, bg, radius)
    W, H = c.size
    sc = fit(content, round(W*ratio), round(H*ratio))
    c.alpha_composite(sc, ((W-sc.width)//2 + offset[0], (H-sc.height)//2 + offset[1]))
    return c


def flatten(img, bg):
    b = Image.new("RGBA", img.size, bg)
    b.alpha_composite(img)
    return b.convert("RGB")


def save(img, rel, rgb_bg=None):
    p = os.path.join(DST, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    (flatten(img, rgb_bg) if rgb_bg else img).save(p, optimize=True)
    print(f"  {rel:44s} {img.size[0]}x{img.size[1]}")


def whiten(img):
    """Recolour the near-neutral letterforms to white, keeping the cyan dot."""
    a = np.asarray(img).astype(np.float32).copy()
    sat = a[..., :3].max(axis=2) - a[..., :3].min(axis=2)
    m = (sat < 45) & (a[..., 3] > 0)
    a[m, 0] = a[m, 1] = a[m, 2] = 255.0
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def svg_wrap(png, size, rounded=None):
    b = io.BytesIO(); png.save(b, format="PNG", optimize=True)
    d = base64.b64encode(b.getvalue()).decode()
    bg = ""
    if rounded:
        r, col = rounded
        bg = f'\n  <rect width="{size}" height="{size}" rx="{r}" ry="{r}" fill="{col}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{size}" height="{size}" viewBox="0 0 {size} {size}">{bg}\n'
            f'  <image x="0" y="0" width="{size}" height="{size}" '
            f'xlink:href="data:image/png;base64,{d}"/>\n</svg>\n')


def main():
    lockup, _, _ = cutout()
    W, H = lockup.size
    lockup = bleed(lockup)
    mark = bleed(trim(lockup.crop((0, 0, W, WORD_TOP))))
    word = bleed(trim(lockup.crop((0, WORD_TOP, W, H))))
    word_w = whiten(word)
    print(f"source {W}x{H} | mark {mark.size} | word {word.size}")

    print("\nimport/")
    save(lockup, "import/source-hires.png")

    print("\npng/ — mark (transparent)")
    for s in (1024, 512, 256):
        save(compose(mark, s, 0.88), f"png/navide-mark-{s}.png")
    save(compose(mark, 512, 0.82), "png/navide-mark-on-white-512.png", WHITE)

    print("\npng/ — app icon (dark rounded)")
    for s in (1024, 512, 256):
        save(compose(mark, s, 0.62, DARK, round(s*0.2237)), f"png/navide-appicon-{s}.png")

    print("\npng/ — favicon")
    for s in (64, 32):
        save(compose(mark, s, 0.94), f"png/favicon-{s}.png")

    print("\npng/ — lockup")
    save(compose(lockup, (1254, 1254), 0.92), "png/navide-lockup-full.png")

    print("\nlight/ — for light backgrounds")
    for s in (1024, 512):
        save(compose(mark, s, 0.82), f"light/navide-mark-white-{s}.png", WHITE)
    save(compose(mark, 1024, 0.62, WHITE, round(1024*0.2237)), "light/navide-appicon-light-1024.png")
    save(compose(lockup, (1254, 1254), 0.86), "light/navide-lockup-light-2x.png", WHITE)

    # horizontal lockup for the wide social canvases (the stacked one is too tall)
    def horizontal(mark_h, on_dark):
        m = fit(mark, 10**6, mark_h)
        w_img = fit(word_w if on_dark else word, 10**6, round(mark_h*0.30))
        gap = round(mark_h*0.16)
        c = Image.new("RGBA", (m.width + gap + w_img.width,
                               max(m.height, w_img.height)), (0, 0, 0, 0))
        c.alpha_composite(m, (0, (c.height-m.height)//2))
        c.alpha_composite(w_img, (m.width + gap, (c.height-w_img.height)//2))
        return trim(c)

    print("\nsocial/")
    save(compose(horizontal(420, True), (1280, 640), 0.74, DARK), "social/github-social-1280x640.png")
    save(compose(mark, 800, 0.60, DARK), "social/youtube-avatar-800x800.png")
    banner = canvas((2560, 1440), DARK)
    art = fit(horizontal(300, True), round(1546*0.92), round(423*0.92))
    banner.alpha_composite(art, ((2560-art.width)//2, (1440-art.height)//2))
    save(banner, "social/youtube-banner-2560x1440.png")

    print("\nSVG")
    exact = compose(mark, 1024, 0.88)
    with open(os.path.join(DST, "navide-mark-exact.svg"), "w") as f:
        f.write(svg_wrap(exact, 1024))
    print(f"  {'navide-mark-exact.svg':44s} 1024 (embedded PNG)")
    appicon_art = compose(mark, 1024, 0.62)
    with open(os.path.join(DST, "navide-appicon.svg"), "w") as f:
        f.write(svg_wrap(appicon_art, 1024, rounded=(229, "#0d1117")))
    print(f"  {'navide-appicon.svg':44s} 1024 (rounded plate + embedded PNG)")


main()
