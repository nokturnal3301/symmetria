"""Render real migration CLI captures as readable GIFs. Requires Pillow + FFmpeg."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs/assets"
WIDTH, HEIGHT, FPS = 1280, 720, 12
BACKGROUND, PANEL, TEXT = "#0b0e1b", "#101627", "#e7edf8"
MUTED, RED, GREEN = "#a5b1c9", "#f59bb4", "#8be1bc"
LINE_HEIGHT, FIRST_LINE, MAX_LINES = 24, 213, 16


def font(size: int, mono: bool = False, bold: bool = False):
    override = os.environ.get("DEMO_MONO_FONT" if mono else "DEMO_FONT")
    candidates = [override] if override else []
    candidates += (
        [
            "/System/Library/Fonts/Menlo.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "DejaVuSansMono.ttf",
        ]
        if mono
        else [
            f"/System/Library/Fonts/Supplemental/Arial{' Bold' if bold else ''}.ttf",
            f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
            f"DejaVuSans{'-Bold' if bold else ''}.ttf",
        ]
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    raise RuntimeError(
        "Install DejaVu Sans or set DEMO_FONT and DEMO_MONO_FONT."
    )


MONO = font(19, mono=True)
FONTS = {
    "small": font(13),
    "label": font(14, bold=True),
    "body": font(17),
    "caption": font(18, bold=True),
    "title": font(34, bold=True),
}
CELL = MONO.getlength("M")
COLUMNS = int(1152 / CELL)


def wrap(text: str) -> list[str]:
    lines = []
    for line in text.expandtabs(2).splitlines():
        lines.extend(
            textwrap.wrap(
                line,
                width=COLUMNS,
                replace_whitespace=False,
                break_on_hyphens=False,
                subsequent_indent="  ",
            )
            or [""]
        )
    return lines


def output_lines(command: dict) -> list[tuple[str, str]]:
    lines = []
    for stream in ["stdout", "stderr"]:
        for line in wrap(command[stream]):
            shade = RED if stream == "stderr" or command["exitCode"] else TEXT
            if line.startswith(
                (
                    "Applied ",
                    "Repaired ",
                    "Verified ",
                    "No schema drift",
                    "Data check",
                    "Adopted ",
                )
            ):
                shade = GREEN
            elif line.startswith("-- group"):
                shade = "#bca4ff"
            lines.append((line, shade))
    return lines


def timeline(scene: dict) -> tuple[list[dict], float]:
    events, time = [], 0.35
    for command in scene["commands"]:
        typing = max(0.65, len(command["command"]) / 58)
        runtime = max(0.18, min(1.6, command["durationMs"] / 1000))
        event = {
            "command": command,
            "start": time,
            "typed": time + typing,
            "done": time + typing + runtime,
        }
        events.append(event)
        time = event["done"] + 0.45
    return events, time + scene["hold"]


def terminal_lines(events: list[dict], elapsed: float, accent: str):
    lines = []
    cursor = None
    for event in events:
        if elapsed < event["start"]:
            break
        command = event["command"]
        amount = min(
            1, (elapsed - event["start"]) / (event["typed"] - event["start"])
        )
        shown = command["command"][
            : math.floor(amount * len(command["command"]))
        ]
        prompt = wrap(f"$ {shown}")
        lines.extend((line, accent) for line in prompt)
        if elapsed < event["done"]:
            cursor = (len(lines) - 1, len(prompt[-1]))
            break
        lines.extend(output_lines(command))
        lines.append(("", TEXT))
    if lines and lines[-1][0] == "":
        lines.pop()
    return lines, cursor


def frame(
    demo: dict,
    scene_index: int,
    elapsed: float,
    events: list[dict],
    duration: float,
    environment: dict,
):
    scene, accent = demo["scenes"][scene_index], demo["accent"]
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.text(
        (40, 24),
        f"S Y M M E T R I A   /   {demo['label']}",
        font=FONTS["label"],
        fill=accent,
    )
    draw.text(
        (1240, 25),
        f"{scene_index + 1:02d} / {len(demo['scenes']):02d}",
        font=FONTS["label"],
        fill=MUTED,
        anchor="ra",
    )
    draw.text((39, 58), scene["title"], font=FONTS["title"], fill=TEXT)
    draw.text((40, 105), scene["subtitle"], font=FONTS["body"], fill=MUTED)
    draw.rounded_rectangle(
        (32, 150, 1248, 620), radius=16, fill=PANEL, outline="#303950"
    )
    draw.line((33, 194, 1247, 194), fill="#303950")
    for x, color in [(55, "#f59bb4"), (77, "#bca4ff"), (99, "#76deb2")]:
        draw.ellipse((x, 168, x + 10, 178), fill=color)
    draw.text(
        (640, 164),
        "migration workspace",
        font=FONTS["body"],
        fill=MUTED,
        anchor="ma",
    )
    draw.text(
        (1224, 166),
        "LOCAL POSTGRESQL",
        font=FONTS["small"],
        fill=GREEN,
        anchor="ra",
    )
    lines, cursor = terminal_lines(events, elapsed, accent)
    assert (
        len(lines) <= MAX_LINES
    ), f"{demo['id']} scene {scene_index}: {len(lines)} lines exceed the terminal"
    for index, (line, color) in enumerate(lines):
        draw.text(
            (55, FIRST_LINE + index * LINE_HEIGHT), line, font=MONO, fill=color
        )
    row = 0
    for event in events:
        if elapsed < event["done"]:
            break
        command = event["command"]
        draw.text(
            (1224, FIRST_LINE + row * LINE_HEIGHT + 3),
            f"EXIT {command['exitCode']}",
            font=FONTS["small"],
            fill=RED if command["exitCode"] else GREEN,
            anchor="ra",
        )
        row += (
            len(wrap(f"$ {command['command']}"))
            + len(output_lines(command))
            + 1
        )
    if cursor and int(elapsed * 2) % 2 == 0:
        row, column = cursor
        x, y = 55 + column * CELL, FIRST_LINE + row * LINE_HEIGHT
        draw.rectangle((x + 1, y + 3, x + 9, y + 21), fill=accent)
    draw.text((40, 641), scene["caption"], font=FONTS["caption"], fill=TEXT)
    completed = [event for event in events if elapsed >= event["done"]]
    running = any(event["start"] <= elapsed < event["done"] for event in events)
    state = (
        f"EXIT {completed[-1]['command']['exitCode']}"
        if completed and not running
        else "RUNNING"
    )
    if completed and not running and completed[-1]["command"]["exitCode"]:
        state += " · EXPECTED"
    draw.text(
        (40, 676),
        f"Bun {environment['bun']}  /  PostgreSQL {environment['postgres'].split()[0]}  /  Recorded CLI output",
        font=FONTS["small"],
        fill=MUTED,
    )
    draw.text(
        (1240, 676),
        state,
        font=FONTS["label"],
        fill=RED if "EXPECTED" in state else GREEN,
        anchor="ra",
    )
    draw.line((40, 707, 1240, 707), fill="#303950", width=2)
    progress = (scene_index + min(1, elapsed / duration)) / len(demo["scenes"])
    draw.line((40, 707, 40 + 1200 * progress, 707), fill=accent, width=2)
    return image


def render(demo: dict, environment: dict, cache: Path) -> dict:
    with tempfile.TemporaryDirectory(
        prefix=f"{demo['id']}-", dir=cache
    ) as directory:
        temporary = Path(directory)
        count, contact = 0, []
        for scene_index, scene in enumerate(demo["scenes"]):
            events, duration = timeline(scene)
            for local in range(math.ceil(duration * FPS)):
                image = frame(
                    demo,
                    scene_index,
                    local / FPS,
                    events,
                    duration,
                    environment,
                )
                image.save(temporary / f"{count:05d}.png")
                count += 1
            still = frame(
                demo, scene_index, duration, events, duration, environment
            )
            contact.append(still)
            if scene_index == demo["preview"]:
                still.save(ASSETS / f"{demo['id']}.png")
        sheet = Image.new("RGB", (WIDTH, HEIGHT * len(contact)), BACKGROUND)
        for index, image in enumerate(contact):
            sheet.paste(image, (0, index * HEIGHT))
        sheet.save(cache / f"{demo['id']}-contact.png")
        common = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-framerate",
            str(FPS),
            "-i",
            str(temporary / "%05d.png"),
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
        output = ASSETS / f"{demo['id']}.gif"
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
            assert gif.size == (WIDTH, HEIGHT) and gif.n_frames == count
            assert gif.info["loop"] == 0
            seconds = 0
            for index in range(gif.n_frames):
                gif.seek(index)
                seconds += gif.info["duration"] / 1000
        assert (
            output.stat().st_size < 3 * 1024 * 1024
        ), "Keep README GIFs lightweight"
        return {
            "file": output.name,
            "width": WIDTH,
            "height": HEIGHT,
            "frames": count,
            "seconds": round(seconds, 2),
            "bytes": output.stat().st_size,
        }


def main():
    if not shutil.which("ffmpeg"):
        raise RuntimeError("FFmpeg is required")
    capture = json.loads(
        (Path(__file__).parent / "migrations.json").read_text()
    )
    assert capture["version"] == 1
    cache = ROOT / ".build/migration-demos"
    cache.mkdir(parents=True, exist_ok=True)
    results = [
        render(demo, capture["environment"], cache) for demo in capture["demos"]
    ]
    (cache / "render.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
