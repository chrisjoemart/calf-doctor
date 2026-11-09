# Simple app icon: green square, white ear tag shape with "CD".
import sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
for size in (192, 512, 180):
    img = Image.new('RGB', (size, size), '#14532d')
    d = ImageDraw.Draw(img)
    s = size / 512
    # ear tag: rounded rectangle with a hole
    d.rounded_rectangle([136*s, 120*s, 376*s, 420*s], radius=60*s, fill='#facc15')
    d.ellipse([226*s, 140*s, 286*s, 200*s], fill='#14532d')
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(120*s))
    d.text((256*s, 315*s), '42', font=f, fill='#1c1917', anchor='mm')
    name = 'apple-touch-icon.png' if size == 180 else f'icon-{size}.png'
    img.save(f'{out}/{name}')
print('ok')
