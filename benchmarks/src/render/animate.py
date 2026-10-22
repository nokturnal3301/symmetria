"""Render the verified report as a readable, looping GIF. Requires Pillow + FFmpeg."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BENCHMARK = Path(__file__).resolve().parents[2]
ROOT = BENCHMARK.parent
WIDTH, HEIGHT, FPS = 1280, 720, 12
SECONDS, TRANSITION = 6, 0.5
TEXT, MUTED = "#e7edf8", "#a7b4cc"
COLORS = {
    "raw": "#94a5b8",
    "raw-page-first": "#b7c6d6",
    "symmetria": "#59bcff",
    "drizzle": "#b9cf8b",
    "kysely": "#aca0ff",
    "prisma-join": "#f68bda",
    "prisma-query": "#d6a3c9",
}
NAMES = {
    "raw": "Bun.SQL · direct",
    "raw-page-first": "Bun.SQL · page first",
    "symmetria": "Symmetria",
    "drizzle": "Drizzle",
    "kysely": "Kysely",
    "prisma-join": "Prisma · join",
    "prisma-query": "Prisma · query",
}
SCENES = [
    (
        "nestedKeyset",
        "Nested reads.",
        "50 users × up to 3 posts × tags · keyset pagination",
        "ms / operation",
        "READ",
        False,
    ),
    (
        "insertMany500",
        "Bulk writes.",
        "500 rows per INSERT · no RETURNING · durable PostgreSQL",
        "ms / batch",
        "WRITE",
        False,
    ),
    (
        "pointLookup",
        "Concurrent lookups.",
        "16 workers · application operations, not SQL statements",
        "operations / second",
        "THROUGHPUT",
        True,
    ),
    (
        "buildNested",
        "Before the database.",
        "Fresh nested query + SQL · synchronous batches of 100 · no I/O",
        "µs / build",
        "CLIENT",
        False,
    ),
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    override = os.environ.get("BENCH_FONT_BOLD" if bold else "BENCH_FONT")
    candidates = [override] if override else []
    candidates += [
        f"/System/Library/Fonts/Supplemental/Arial{' Bold' if bold else ''}.ttf",
        f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
        f"DejaVuSans{'-Bold' if bold else ''}.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    raise RuntimeError(
        "Install DejaVu Sans or set BENCH_FONT and BENCH_FONT_BOLD."
    )


FONTS = {size: font(size) for size in [12, 13, 14, 16, 17, 19]}
FONTS.update(
    {"hero": font(46, True), "number": font(23, True), "brand": font(14, True)}
)


def rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))


def background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)
    for x in range(WIDTH):
        ratio = x / (WIDTH - 1)
        draw.line(
            (x, 0, x, HEIGHT),
            fill=(int(8 + 14 * ratio), int(14 - ratio), int(29 + 3 * ratio)),
        )
    glow = Image.new("RGB", image.size)
    brush = ImageDraw.Draw(glow)
    brush.ellipse((700, -330, 1460, 410), fill=(21, 19, 48))
    brush.ellipse((-400, 350, 250, 1000), fill=(8, 27, 47))
    return Image.blend(image, glow.filter(ImageFilter.GaussianBlur(95)), 0.3)


def values(
    row: dict, throughput: bool, compiler: bool
) -> tuple[float, list[float]]:
    if throughput:
        return row["concurrentOps"], row["concurrentPasses"]
    scale = 1000 if compiler else 1
    return row["p50Ms"] * scale, [value * scale for value in row["p50PassesMs"]]


def number(value: float, throughput: bool, compiler: bool) -> str:
    return (
        f"{value:,.0f}"
        if throughput
        else f"{value:.1f}" if compiler else f"{value:.3f}"
    )


def slide(data: dict, index: int) -> Image.Image:
    scenario, title, subtitle, unit, _, throughput = SCENES[index]
    compiler = scenario == "buildNested"
    rows = data["summary"][scenario]
    image = background()
    draw = ImageDraw.Draw(image)
    draw.text(
        (48, 30),
        "S Y M M E T R I A   /   B E N C H M A R K S",
        font=FONTS["brand"],
        fill="#59bcff",
    )
    draw.text((46, 66), title, font=FONTS["hero"], fill=TEXT)
    draw.text((48, 124), subtitle, font=FONTS[17], fill=MUTED)
    for tab, (_, _, _, _, label, _) in enumerate(SCENES):
        x = 48 + tab * 296
        color = (
            ["#59bcff", "#aca0ff", "#f68bda", "#59bcff"][tab]
            if tab == index
            else "#68788e"
        )
        draw.text((x, 170), f"0{tab + 1}  {label}", font=FONTS[13], fill=color)
        draw.line((x, 196, x + 272, 196), fill="#263044", width=2)
    draw.rounded_rectangle(
        (32, 216, 1248, 604), radius=18, fill="#101728", outline="#283047"
    )
    draw.text((56, 231), "ADAPTER", font=FONTS[12], fill=MUTED)
    caption = f"{'THROUGHPUT · HIGHER' if throughput else 'MEDIAN P50 · LOWER'} IS BETTER"
    draw.text((1218, 231), caption, font=FONTS[12], fill=MUTED, anchor="ra")
    left, plot_width = 345, 653
    maximum = max(max(values(row, throughput, compiler)[1]) for row in rows)
    magnitude = 10 ** math.floor(math.log10(maximum))
    ceiling = math.ceil(maximum / magnitude) * magnitude
    position = lambda value: left + value / ceiling * plot_width
    plot_bottom = 560
    for tick in range(5):
        value = ceiling * tick / 4
        x = position(value)
        draw.line((x, 266, x, plot_bottom), fill="#252c40")
        label = f"{value / 1000:g}k" if throughput else f"{value:g}"
        draw.text(
            (x, plot_bottom + 15),
            label,
            font=FONTS[12],
            fill=MUTED,
            anchor="ma",
        )
    draw.text((1218, 575), unit, font=FONTS[13], fill=MUTED, anchor="ra")
    for row_index, row in enumerate(rows):
        middle, passes = values(row, throughput, compiler)
        y = 278 + row_index * (70 if compiler else 43)
        color = COLORS[row["library"]]
        draw.text(
            (57, y - 9), NAMES[row["library"]], font=FONTS[19], fill=color
        )
        end = position(middle)
        muted_color = tuple(int(channel * 0.29) for channel in rgb(color))
        draw.rounded_rectangle(
            (left, y - 6, max(left + 2, end), y + 6), radius=3, fill=muted_color
        )
        low, high = position(min(passes)), position(max(passes))
        draw.line((low, y, high, y), fill=color, width=2)
        for pass_index, value in enumerate(passes):
            x, dy = position(value), (pass_index - (len(passes) - 1) / 2) * 3
            draw.ellipse((x - 2, y + dy - 2, x + 2, y + dy + 2), fill=color)
        draw.line((end, y - 9, end, y + 9), fill=color, width=3)
        draw.text(
            (1218, y - 17),
            number(middle, throughput, compiler),
            font=FONTS["number"],
            fill=color,
            anchor="ra",
        )
        span = f"{number(min(passes), throughput, compiler)} – {number(max(passes), throughput, compiler)}"
        draw.text((1218, y + 10), span, font=FONTS[12], fill=MUTED, anchor="ra")
    if compiler:
        draw.text(
            (57, 508),
            "Raw has no ORM compiler. Prisma has no equivalent synchronous API.",
            font=FONTS[16],
            fill=MUTED,
        )
        draw.text(
            (57, 534),
            "Each measurement constructs a new query. No prepared-query cache hits.",
            font=FONTS[14],
            fill=MUTED,
        )
    env = data["environment"]
    draw.text(
        (48, 624),
        f"Bun {env['bun']}  /  PostgreSQL 16.10  /  Linux {env['arch']}  /  {env['host']}  /  2 CPU + 2 GiB per container",
        font=FONTS[14],
        fill=TEXT,
    )
    draw.text(
        (48, 650),
        f"{env['passes']} passes · dots = passes · tick = median · range = min–max, not a confidence interval · zero-based linear scale",
        font=FONTS[13],
        fill=MUTED,
    )
    draw.text(
        (48, 680),
        f"WARM SYNTHETIC WORKLOAD    /    {data['run'][:10]}    /    source {data['sourceHash'][:12]}",
        font=FONTS[12],
        fill="#7d8ca5",
    )
    draw.text(
        (1230, 680),
        "FULL TABLES + SOURCE → benchmarks/report",
        font=FONTS[12],
        fill="#a99eef",
        anchor="ra",
    )
    return image


def ornament(
    image: Image.Image, elapsed: float, index: int, progress: float
) -> None:
    """Animate only decoration/progress; measured bar lengths and numbers stay fixed."""
    draw = ImageDraw.Draw(image)
    points = []
    for step in range(161):
        angle = step / 160 * math.tau
        points.append(
            (1116 + 96 * math.sin(angle), 96 + 36 * math.sin(2 * angle))
        )
    for strand in [-4, 0, 4]:
        draw.line([(x, y + strand) for x, y in points], fill="#33315b", width=1)
    for offset, color in [(0, "#59bcff"), (0.5, "#f68bda")]:
        phase = (elapsed / 9 + offset) % 1
        for trail in range(13):
            angle = (phase - trail * 0.004) * math.tau
            x, y = 1116 + 96 * math.sin(angle), 96 + 36 * math.sin(2 * angle)
            fade = 1 - trail / 13
            shade = tuple(
                int(channel * (0.3 + 0.7 * fade)) for channel in rgb(color)
            )
            r = 1 + fade * 2
            draw.ellipse((x - r, y - r, x + r, y + r), fill=shade)
    x = 48 + index * 296
    draw.line(
        (x, 196, x + 272 * progress, 196), fill=COLORS["symmetria"], width=2
    )


def main() -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("FFmpeg is required to render benchmarks.gif")
    data = json.loads((BENCHMARK / "report/summary.json").read_text())
    slides = [slide(data, index) for index in range(len(SCENES))]
    cache = BENCHMARK / ".cache"
    cache.mkdir(exist_ok=True)
    output = ROOT / "docs/assets/benchmarks.gif"
    frames_per_scene = int(SECONDS * FPS)
    total_frames = frames_per_scene * len(slides)
    with tempfile.TemporaryDirectory(
        prefix="animation-", dir=cache
    ) as directory:
        temporary = Path(directory)
        for frame in range(total_frames):
            scene, local = divmod(frame, frames_per_scene)
            seconds = local / FPS
            image = slides[scene].copy()
            ornament(image, frame / FPS, scene, seconds / SECONDS)
            if seconds > SECONDS - TRANSITION:
                following = slides[(scene + 1) % len(slides)].copy()
                ornament(following, frame / FPS, (scene + 1) % len(slides), 0)
                blend = (seconds - SECONDS + TRANSITION) / TRANSITION
                image = Image.blend(
                    image, following, blend * blend * (3 - 2 * blend)
                )
            image.save(temporary / f"{frame:04d}.png")
        slides[0].save(cache / "animation-preview.png")
        pattern = str(temporary / "%04d.png")
        common = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-framerate",
            str(FPS),
            "-i",
            pattern,
        ]
        palette = str(temporary / "palette.png")
        subprocess.run(
            [
                *common,
                "-vf",
                "palettegen=stats_mode=diff",
                "-frames:v",
                "1",
                "-update",
                "1",
                palette,
            ],
            check=True,
        )
        subprocess.run(
            [
                *common,
                "-i",
                palette,
                "-lavfi",
                "paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
                "-loop",
                "0",
                str(output),
            ],
            check=True,
        )
    with Image.open(output) as gif:
        assert gif.size == (WIDTH, HEIGHT) and gif.n_frames == total_frames
    print(
        f"Rendered {output.name}: {WIDTH}×{HEIGHT}, {total_frames} frames, {SECONDS * len(slides):g}s, {output.stat().st_size / 1024 / 1024:.2f} MiB"
    )


if __name__ == "__main__":
    main()
