"""Generate the ICO from the same simple vector geometry used by icon.svg (Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
im = Image.new('RGBA', (1024, 1024))
draw = ImageDraw.Draw(im)
draw.rounded_rectangle((0, 0, 1023, 1023), radius=244, fill='#285c47')
draw.ellipse((212, 360, 624, 784), fill='#edf1d7')
draw.rectangle((528, 220, 624, 768), fill='#edf1d7')
draw.ellipse((316, 448, 528, 696), fill='#285c47')
draw.ellipse((700, 660, 820, 780), fill='#c8dc8e')
im.resize((256, 256), Image.Resampling.LANCZOS).save(root / 'assets' / 'icon.ico', sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)])
