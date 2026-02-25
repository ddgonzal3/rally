#!/usr/bin/env python3
"""Generate Rally app icon - warm amber/red gradient with bold chevron mark."""

from PIL import Image, ImageDraw, ImageFilter
import math
import os
import subprocess
import shutil

SIZE = 1024
ICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src-tauri', 'icons')


def lerp(a, b, t):
    return a + (b - a) * t


def color_at(t):
    """Gradient from deep crimson to warm amber-gold."""
    r = int(lerp(148, 235, t))
    g = int(lerp(30, 155, t))
    b = int(lerp(35, 30, t))
    return (r, g, b, 255)


def draw_round_line(draw, start, end, width, color):
    """Draw a thick line with round end caps."""
    draw.line([start, end], fill=color, width=width)
    r = width // 2
    for pt in [start, end]:
        draw.ellipse(
            [pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r],
            fill=color,
        )


def draw_chevron(draw, tip_x, tip_y, arm_len, half_angle_deg, thickness, color):
    """Draw a right-pointing chevron '>' with round caps.

    tip_x, tip_y: the rightmost point of the chevron
    arm_len: length of each arm
    half_angle_deg: angle of each arm from horizontal
    """
    angle = math.radians(half_angle_deg)

    # Upper arm goes from tip up-left
    upper_end = (
        tip_x - arm_len * math.cos(angle),
        tip_y - arm_len * math.sin(angle),
    )
    # Lower arm goes from tip down-left
    lower_end = (
        tip_x - arm_len * math.cos(angle),
        tip_y + arm_len * math.sin(angle),
    )

    tip = (tip_x, tip_y)
    draw_round_line(draw, upper_end, tip, thickness, color)
    draw_round_line(draw, tip, lower_end, thickness, color)


def create_icon(size=SIZE):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    pad = int(size * 0.039)
    corner = int(size * 0.185)

    # --- Gradient background ---
    grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            grad.putpixel((x, y), color_at(t))

    # Rounded-rect mask
    mask = Image.new('L', (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([pad, pad, size - pad - 1, size - pad - 1], radius=corner, fill=255)
    grad.putalpha(mask)
    img = Image.alpha_composite(img, grad)

    # --- Three bold chevrons pointing right ---
    overlay = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)

    s = size / 512
    center_y = int(256 * s)
    thickness = int(42 * s)

    # Back chevron (leftmost, most transparent)
    draw_chevron(
        odraw,
        tip_x=int(255 * s), tip_y=center_y,
        arm_len=int(145 * s),
        half_angle_deg=35,
        thickness=thickness,
        color=(255, 255, 255, 70),
    )

    # Middle chevron
    draw_chevron(
        odraw,
        tip_x=int(315 * s), tip_y=center_y,
        arm_len=int(145 * s),
        half_angle_deg=35,
        thickness=thickness,
        color=(255, 255, 255, 140),
    )

    # Front chevron (rightmost, boldest)
    draw_chevron(
        odraw,
        tip_x=int(375 * s), tip_y=center_y,
        arm_len=int(145 * s),
        half_angle_deg=35,
        thickness=thickness,
        color=(255, 255, 255, 230),
    )

    img = Image.alpha_composite(img, overlay)

    return img


def main():
    print("Generating 1024x1024 master icon...")
    icon = create_icon(1024)

    master_path = os.path.join(ICON_DIR, 'icon.png')
    icon.save(master_path, 'PNG')
    print(f"  Saved {master_path}")

    sizes = {
        '32x32.png': 32,
        '128x128.png': 128,
        '128x128@2x.png': 256,
        'Square30x30Logo.png': 30,
        'Square44x44Logo.png': 44,
        'Square71x71Logo.png': 71,
        'Square89x89Logo.png': 89,
        'Square107x107Logo.png': 107,
        'Square142x142Logo.png': 142,
        'Square150x150Logo.png': 150,
        'Square284x284Logo.png': 284,
        'Square310x310Logo.png': 310,
        'StoreLogo.png': 50,
    }

    for filename, sz in sizes.items():
        resized = icon.resize((sz, sz), Image.LANCZOS)
        path = os.path.join(ICON_DIR, filename)
        resized.save(path, 'PNG')
        print(f"  {filename} ({sz}x{sz})")

    # .icns
    print("Generating .icns...")
    iconset_dir = os.path.join(ICON_DIR, 'icon.iconset')
    os.makedirs(iconset_dir, exist_ok=True)
    for sz in [16, 32, 64, 128, 256, 512, 1024]:
        resized = icon.resize((sz, sz), Image.LANCZOS)
        if sz <= 512:
            resized.save(os.path.join(iconset_dir, f'icon_{sz}x{sz}.png'), 'PNG')
        if sz >= 32:
            resized.save(os.path.join(iconset_dir, f'icon_{sz // 2}x{sz // 2}@2x.png'), 'PNG')
    subprocess.run(['iconutil', '-c', 'icns', iconset_dir, '-o', os.path.join(ICON_DIR, 'icon.icns')], check=True)
    shutil.rmtree(iconset_dir)

    # .ico
    print("Generating .ico...")
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [icon.resize((sz, sz), Image.LANCZOS) for sz in ico_sizes]
    ico_images[0].save(
        os.path.join(ICON_DIR, 'icon.ico'),
        format='ICO',
        sizes=[(sz, sz) for sz in ico_sizes],
        append_images=ico_images[1:],
    )

    print("Done!")


if __name__ == '__main__':
    main()
