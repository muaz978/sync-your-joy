from pathlib import Path

from PIL import Image, ImageDraw

output = Path(__file__).resolve().parents[1] / "apps" / "extension" / "static" / "icons"
output.mkdir(parents=True, exist_ok=True)

for size in (16, 32, 48, 128):
    scale = 4
    canvas_size = size * scale
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(canvas_size * 0.24)
    draw.rounded_rectangle((0, 0, canvas_size - 1, canvas_size - 1), radius=radius, fill=(15, 118, 110, 255))

    stroke = max(2, int(canvas_size * 0.095))
    left = (int(canvas_size * 0.30), int(canvas_size * 0.60), int(canvas_size * 0.53), int(canvas_size * 0.37))
    right = (int(canvas_size * 0.70), int(canvas_size * 0.40), int(canvas_size * 0.47), int(canvas_size * 0.63))
    ink = (236, 254, 255, 255)
    draw.line(left, fill=ink, width=stroke, joint="curve")
    draw.line(right, fill=ink, width=stroke, joint="curve")
    draw.line((int(canvas_size * 0.37), int(canvas_size * 0.64), int(canvas_size * 0.63), int(canvas_size * 0.36)), fill=ink, width=stroke, joint="curve")
    draw.line((int(canvas_size * 0.63), int(canvas_size * 0.64), int(canvas_size * 0.37), int(canvas_size * 0.36)), fill=ink, width=stroke, joint="curve")

    image.resize((size, size), Image.Resampling.LANCZOS).save(output / f"icon-{size}.png")
