#!/usr/bin/env python3
"""Builds media/ from the helper's own drawing of the demo data (demo/demo-data.json).

The helper runs off-screen (ISLAND_OFFSCREEN=1) and draws its own view into PNG frames; nothing is
read from the screen. The frames are composited over a generated desktop: gradient wallpaper, a menu
bar with generic items, and a blurred generic editor window.

Needs Pillow and ffmpeg:  python3 -m pip install pillow; brew install ffmpeg
Run:  python3 tools/make_media.py
"""
import os, shutil, subprocess, sys, tempfile, time
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(__file__))
import demo  # noqa: E402

ROOT = demo.ROOT
OUT = os.path.join(ROOT, 'media')
W, H = 1600, 1000          # cover and screenshots (16:10)
S = 2                      # helper draws at 2x
BAR = 24                   # menu bar height in points

FONT = '/System/Library/Fonts/SFNS.ttf'
CJK = '/System/Library/Fonts/Hiragino Sans GB.ttc'


def font(size, cjk=False, bold=False):
    try:
        f = ImageFont.truetype(CJK if cjk else FONT, size, index=(1 if (cjk and bold) else 0))
        if not cjk and bold:
            try:
                f.set_variation_by_name('Semibold')
            except Exception:
                pass
        return f
    except OSError:
        return ImageFont.load_default()


# ---------------------------------------------------------------- desktop

def wallpaper(w, h):
    """A soft diagonal gradient with two blurred colour blobs."""
    top, bottom = (38, 52, 92), (118, 72, 128)
    g = Image.new('RGB', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    img = g.resize((w, h))
    blobs = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(blobs)
    d.ellipse((int(w * .55), int(h * .35), int(w * 1.1), int(h * 1.05)), fill=(230, 120, 90))
    d.ellipse((int(-w * .15), int(h * .5), int(w * .4), int(h * 1.2)), fill=(70, 150, 200))
    blobs = blobs.filter(ImageFilter.GaussianBlur(w // 8))
    return Image.blend(img, Image.composite(blobs, img, blobs.convert('L')), .45)


def editor_window(w, h):
    """A generic code editor: title bar dots, a sidebar and grey code lines (no real content)."""
    win = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(win)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 14, fill=(30, 32, 40, 255))
    d.rounded_rectangle((0, 0, w - 1, 38), 14, fill=(42, 44, 54, 255))
    d.rectangle((0, 24, w - 1, 38), fill=(42, 44, 54, 255))
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse((16 + i * 22, 13, 28 + i * 22, 25), fill=c)
    d.rectangle((0, 39, 220, h - 1), fill=(36, 38, 47, 255))
    import random
    rnd = random.Random(7)
    for i in range(14):
        d.rounded_rectangle((24, 62 + i * 28, 24 + rnd.randint(70, 160), 72 + i * 28), 4, fill=(70, 74, 90, 255))
    colours = [(120, 160, 230), (200, 140, 220), (150, 200, 140), (210, 180, 120), (130, 135, 150)]
    y = 62
    while y < h - 30:
        x = 250 + rnd.choice([0, 0, 24, 48])
        for _ in range(rnd.randint(1, 4)):
            ln = rnd.randint(30, 140)
            if x + ln > w - 30:
                break
            d.rounded_rectangle((x, y, x + ln, y + 10), 4, fill=colours[rnd.randrange(len(colours))] + (255,))
            x += ln + 12
        y += 26
    return win


def menubar(img, sigma):
    """A translucent menu bar with generic items and a clock. The centre stays free for the island."""
    w = img.width
    bh = int(BAR * sigma)
    bar = img.crop((0, 0, w, bh)).filter(ImageFilter.GaussianBlur(12 * sigma))
    bar = Image.blend(bar, Image.new('RGB', bar.size, (20, 22, 30)), .45)
    img.paste(bar, (0, 0))
    d = ImageDraw.Draw(img)
    f, fb = font(int(13 * sigma)), font(int(13 * sigma), bold=True)
    ty = int(4 * sigma)
    x = 18 * sigma
    d.ellipse((x, 7 * sigma, x + 10 * sigma, 17 * sigma), fill=(235, 235, 240))  # a plain dot, not a logo
    x += 26 * sigma
    stop = w / 2 - 230 * sigma  # the island's widest peek never covers the menu
    for i, t in enumerate(['Editor', 'File', 'Edit', 'View', 'Window', 'Help']):
        ff = fb if i == 0 else f
        if x + d.textlength(t, font=ff) > stop:
            break
        d.text((x, ty), t, font=ff, fill=(240, 240, 245))
        x += d.textlength(t, font=ff) + 18 * sigma
    x = w - 18 * sigma - d.textlength('Wed 9:41', font=f)
    d.text((x, ty), 'Wed 9:41', font=f, fill=(240, 240, 245))
    for _ in range(3):  # generic status icons
        x -= 30 * sigma
        d.rounded_rectangle((x, 7 * sigma, x + 14 * sigma, 17 * sigma), 3 * sigma, outline=(235, 235, 240), width=max(1, int(sigma)))


def desktop(w, h, sigma, blur=6):
    """A desktop of w x h pixels where one point is sigma pixels."""
    img = wallpaper(w, h).convert('RGBA')
    ew, eh = int(w * .62), int(h * .66)
    win = editor_window(ew, eh)
    shadow = Image.new('RGBA', (ew + 80, eh + 80), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((40, 50, ew + 40, eh + 40), 16, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    ox, oy = int(w * .19), int(h * .22)
    img.alpha_composite(shadow, (ox - 40, oy - 40))
    img.alpha_composite(win, (ox, oy))
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    img = img.convert('RGB')
    menubar(img, sigma)
    return img


def place(bg, frame, sigma):
    """The island frame (drawn at 2x) top-centred: its pill sits in the menu bar."""
    k = sigma / S
    fr = frame if k == 1 else frame.resize((round(frame.width * k), round(frame.height * k)), Image.LANCZOS)
    out = bg.convert('RGBA')
    out.alpha_composite(fr, ((bg.width - fr.width) // 2, 0))
    return out.convert('RGB')


def height_pt(frame):
    box = frame.split()[3].getbbox()
    return (box[3] if box else frame.height) / S


# ---------------------------------------------------------------- helper scenes

def settle(s=1.2):
    time.sleep(s * demo.SLOW)


def scene(fn):
    h = demo.Helper()
    try:
        return fn(h)
    finally:
        h.close()


def opened(h, mode='project'):
    demo.load(h, mode=mode)
    settle(1)
    h.act('pill', screen=0)
    settle(1.2)


def snap(h, tmp, name):
    p = os.path.join(tmp, name + '.png')
    h.snap(p)
    return Image.open(p).convert('RGBA')


def record(h, tmp, seconds, action, fps=25):
    d = tempfile.mkdtemp(dir=tmp)
    n = h.record(d, seconds, fps)
    time.sleep(0.02 * demo.SLOW)
    action()
    r = h.wait('recorded', n, timeout=60 + seconds * demo.SLOW * 3)
    if r.get('late'):
        print(f'  warning: {r["late"]} of {r["frames"]} frames late', file=sys.stderr)
    return [Image.open(os.path.join(d, f)).convert('RGBA') for f in sorted(os.listdir(d))]


def stills(tmp):
    out = {}

    def peek(h):
        demo.load(h)
        settle(1)
        h.send({'type': 'peek', 'id': 't-deploy', 'ttlMs': 600000})
        settle(1)
        return snap(h, tmp, 'peek')
    out['peek'] = scene(peek)

    def project(h):
        opened(h)
        return snap(h, tmp, 'list-project')
    out['list-project'] = scene(project)

    def bot(h):
        opened(h, 'bot')
        h.act('set_mode', mode='bot')
        settle(1)
        return snap(h, tmp, 'list-bot')
    out['list-bot'] = scene(bot)

    def detail(id, name):
        def run(h):
            opened(h)
            h.act('open', id=id)
            time.sleep(.2 * demo.SLOW)
            demo.detail(h, id)
            settle(1.4)
            return snap(h, tmp, name)
        return run
    out['detail-prompt'] = scene(detail('t-deploy', 'detail-prompt'))
    out['detail-bot'] = scene(detail('b-release', 'detail-bot'))

    def settings(h):
        # The real defaults: answering off, hidden from capture.
        h.send({'type': 'config', 'config': {'hotkey': False, 'answerGranted': True, 'allowAnswer': False, 'hideFromCapture': True}})
        opened(h)
        h.act('settings')
        settle(1.2)
        return snap(h, tmp, 'settings')
    out['settings'] = scene(settings)

    def power(h):
        opened(h)
        h.act('power_menu')
        settle(1)
        return snap(h, tmp, 'power')
    out['power'] = scene(power)

    def hint(h):
        demo.load(h)
        settle(1)
        h.send({'type': 'hint', 'text': '已打开 atlas，请在右侧切到「主页」查看待你决定'})
        settle(1)
        return snap(h, tmp, 'hint')
    out['hint'] = scene(hint)

    def away(h):
        h.send({'type': 'config', 'config': {'hotkey': False, 'debugAwayNow': True}})
        demo.load(h)
        settle(1)
        a = demo.DATA['awaySummary']
        h.send({'type': 'peek', 'text': '\n'.join([a['title']] + a['lines']), 'ttlMs': 600000, **a})
        settle(1.2)
        return snap(h, tmp, 'away')
    out['away'] = scene(away)
    return out


def gif_answer(tmp):
    """Peek -> click -> list -> open the prompt -> pick Yes -> sent -> the row leaves, as in the real island."""
    def run(h):
        demo.load(h)
        settle(1)
        frames = record(h, tmp, 1.2, lambda: h.send({'type': 'peek', 'id': 't-deploy', 'ttlMs': 600000}))
        frames += record(h, tmp, 1.4, lambda: h.act('pill', screen=0))

        def open_it():
            h.act('open', id='t-deploy')
            time.sleep(.15 * demo.SLOW)
            demo.detail(h, 't-deploy')
        frames += record(h, tmp, 1.8, open_it)

        def answer():
            h.act('answer', id='t-deploy', option=1, signature='demo')
            time.sleep(.5 * demo.SLOW)
            h.send({'type': 'answered', 'id': 't-deploy', 'ok': True, 'text': '已发送：Yes'})
        frames += record(h, tmp, 1.6, answer)

        def resolved():
            # Claude goes back to work: the worker turns the row to running, so it leaves the needs-you group.
            i = dict(next(x for x in demo.DATA['items'] if x['id'] == 't-deploy'))
            i.update(state='working', workSec=380, ageSec=0, detail='', isNew=False)
            h.send({'type': 'upsert', 'item': demo.item(i, unread=False)})
            g = demo.groups('project')
            for grp in g:
                if grp['key'] == 'web-app':
                    grp['counts'] = {'needs_you': 0, 'failed': 0, 'done': 0, 'working': 1}
            h.send({'type': 'groups', 'mode': 'project', 'groups': g})
        frames += record(h, tmp, 1.4, resolved)
        return frames
    return scene(run)


def gif_hover(tmp):
    """Hover: the pill grows and glows; in the list, the row under the pointer lights up and shows ↗."""
    def run(h):
        demo.load(h)
        settle(1)
        frames = record(h, tmp, 0.9, lambda: h.send({'type': 'debug_hover', 'inside': True}))
        frames += record(h, tmp, 0.7, lambda: h.send({'type': 'debug_hover', 'inside': False}))
        frames += record(h, tmp, 0.7, lambda: h.send({'type': 'debug_hover', 'inside': True}))
        frames += record(h, tmp, 1.2, lambda: h.act('pill', screen=0))
        for rid in ['b-release', 'c-atlas', 'a-nightly', 't-api']:
            frames += record(h, tmp, 0.55, lambda rid=rid: h.send({'type': 'debug_hover_row', 'id': rid}))
        return frames
    return scene(run)


def gif_finishing(tmp):
    """Three agents finish together: one peek with +2, the counts tick up; then 清空已完成 clears them."""
    def run(h):
        later = set(demo.DATA['finishing'])
        demo.load(h, ids=[i['id'] for i in demo.DATA['items'] if i['id'] not in later])
        settle(1)
        h.act('pill', screen=0)
        settle(1)

        def finish():
            # One after another, a moment apart, as real turns end.
            for k, i in enumerate([x for x in demo.DATA['items'] if x['id'] in later]):
                h.send({'type': 'upsert', 'item': demo.item(i)})
                h.send({'type': 'groups', 'mode': 'project', 'groups': demo.groups('project')})
                time.sleep(.35 * demo.SLOW)
        frames = record(h, tmp, 1.8, finish)

        def clear():
            h.act('clear_finished')
            time.sleep(.1 * demo.SLOW)
            h.send({'type': 'toast', 'text': '已清空 3 项', 'undo': True})
        frames += record(h, tmp, 1.8, clear)
        return frames
    return scene(run)


def hero(path, frames):
    """Cover: the peek, the list and a prompt side by side over the desktop, with the tagline."""
    sigma = 1.0
    bg = desktop(W, H, 1.0, blur=8)
    img = bg.convert('RGBA')

    def card(fr, k):
        box = fr.split()[3].getbbox()
        c = fr.crop(box)
        return c.resize((round(c.width * k), round(c.height * k)), Image.LANCZOS)
    peek, lst, det = card(frames['peek'], .62), card(frames['list-project'], .5), card(frames['detail-prompt'], .5)
    # The peek sits in the menu bar, top centre; the list and the prompt float below it.
    img.alpha_composite(peek, ((W - peek.width) // 2, 0))
    for c, x in ((lst, 150), (det, W - 150 - det.width)):
        sh = Image.new('RGBA', (c.width + 80, c.height + 80), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((40, 48, c.width + 40, c.height + 40), 28, fill=(0, 0, 0, 150))
        sh = sh.filter(ImageFilter.GaussianBlur(22))
        img.alpha_composite(sh, (x - 40, 150 - 40))
        img.alpha_composite(c, (x, 150))
    img = img.convert('RGB')
    shade = Image.new('RGBA', (W, 260), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for y in range(260):
        sd.line([(0, y), (W, y)], fill=(12, 10, 24, int(170 * y / 260)))
    img = img.convert('RGBA')
    img.alpha_composite(shade, (0, H - 260))
    img = img.convert('RGB')
    d = ImageDraw.Draw(img)
    d.text((W // 2, H - 150), 'Island for Orca', font=font(64, bold=True), fill=(255, 255, 255), anchor='mm')
    d.text((W // 2, H - 85), 'See which agents need you, at a glance.', font=font(28), fill=(236, 236, 246), anchor='mm')
    img.save(path, optimize=True)


# ---------------------------------------------------------------- outputs

def caption(img, title, sub, sigma=1.0):
    shade = Image.new('RGBA', (img.width, 200), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for y in range(200):
        sd.line([(0, y), (img.width, y)], fill=(12, 10, 24, int(140 * y / 200)))
    base = img.convert('RGBA')
    base.alpha_composite(shade, (0, img.height - 200))
    img.paste(base.convert('RGB'))
    d = ImageDraw.Draw(img)
    pad = 44
    d.text((pad, img.height - pad - 66), title, font=font(30, cjk=True, bold=True), fill=(255, 255, 255))
    d.text((pad, img.height - pad - 22), sub, font=font(19), fill=(228, 228, 238))


def screenshot(frame, title, sub, path):
    """1600x1000, the island as large as fits (never above 2x), with a caption."""
    sigma = min(2.0, (H - 150) / height_pt(frame))
    img = place(desktop(W, H, sigma), frame, sigma)
    caption(img, title, sub)
    img.save(path, optimize=True)


def cover(frame, path):
    sigma = 2.0
    img = place(desktop(W, H, sigma), frame, sigma)
    d = ImageDraw.Draw(img)
    shade = Image.new('RGBA', (W, 300), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for y in range(300):
        sd.line([(0, y), (W, y)], fill=(12, 10, 24, int(150 * y / 300)))
    img = img.convert('RGBA')
    img.alpha_composite(shade, (0, H - 300))
    img = img.convert('RGB')
    d = ImageDraw.Draw(img)
    d.text((80, H - 200), 'Island for Orca', font=font(68, bold=True), fill=(255, 255, 255))
    d.text((84, H - 112), 'See which agents need you, at a glance.', font=font(30), fill=(236, 236, 246))
    img.save(path, optimize=True)


def icon(path):
    n = 1024
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((40, 40, n - 40, n - 40), 220, fill=255)
    img.paste(wallpaper(n, n).convert('RGBA'), (0, 0), mask)
    d = ImageDraw.Draw(img)
    # The island: a black capsule with an amber edge, an amber "needs you" dot and a count bar.
    d.rounded_rectangle((190, 300, 834, 500), 100, fill=(8, 8, 10, 255), outline=(255, 159, 10, 255), width=16)
    d.ellipse((262, 362, 338, 438), fill=(255, 159, 10, 255))
    d.rounded_rectangle((620, 378, 750, 422), 22, fill=(255, 255, 255, 230))
    # Two small waves under it: the sea around the island.
    import math
    for row, alpha in ((640, 190), (740, 120)):
        pts = [(x, row + 26 * math.sin((x - 150) / 724 * 4 * math.pi)) for x in range(150, 875, 6)]
        d.line(pts, fill=(255, 255, 255, alpha), width=26, joint='curve')
    img.resize((256, 256), Image.LANCZOS).save(path, optimize=True)


def gif(frames, path, width=960, height=600, fps=25, hold=1.0):
    max_pt = max(height_pt(f) for f in frames)
    sigma = min(2.0 * width / W * 1.25, (height - 20) / max_pt)
    bg = desktop(width, height, sigma, blur=4)
    d = tempfile.mkdtemp()
    seq = frames + [frames[-1]] * int(hold * fps)
    for i, f in enumerate(seq):
        place(bg, f, sigma).save(os.path.join(d, f'g{i:04d}.png'))
    pal = os.path.join(d, 'pal.png')
    src = ['-framerate', str(fps), '-i', os.path.join(d, 'g%04d.png')]
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *src, '-vf', 'palettegen=max_colors=160:stats_mode=diff', pal], check=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *src, '-i', pal, '-lavfi', 'paletteuse=dither=sierra2_4a:diff_mode=rectangle', path], check=True)
    shutil.rmtree(d)
    return os.path.getsize(path)


def main():
    only = set(sys.argv[1:])
    os.makedirs(os.path.join(OUT, 'screenshots'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'gifs'), exist_ok=True)
    tmp = tempfile.mkdtemp()
    try:
        if not only or 'icon' in only:
            icon(os.path.join(OUT, 'icon.png'))
        if not only or 'stills' in only:
            st = stills(tmp)
            hero(os.path.join(OUT, 'cover.png'), st)
            for name, title, sub in [
                ('peek', '需要你：一眼可见', 'A prompt waiting for you peeks from the top of the screen.'),
                ('list-project', '按项目分组', 'Every agent, bot question and failed run, grouped by project.'),
                ('list-bot', '按 Bot 分组', 'The same list, grouped by bot.'),
                ('detail-prompt', '终端提示：直接回答', 'Pick an option or type a reply (opt-in).'),
                ('detail-bot', 'Bot 的多个问题', 'A bot item with two questions, answered in Orca.'),
                ('settings', '设置', 'Answering is off until you turn it on and confirm.'),
            ]:
                screenshot(st[name], title, sub, os.path.join(OUT, 'screenshots', name + '.png'))
            # README only (the directory takes at most 6 screenshots).
            os.makedirs(os.path.join(OUT, 'readme'), exist_ok=True)
            for name, title, sub in [
                ('power', '一键关闭', 'Off for an hour, until 8 tomorrow, or until you turn it back on.'),
                ('hint', '跳转提示', 'When Orca cannot open the exact tab, the island says where to look.'),
                ('away', '回来时的摘要', 'What changed while you were away, in plain sentences. Click to see those rows.'),
            ]:
                screenshot(st[name], title, sub, os.path.join(OUT, 'readme', name + '.png'))
        for name, fn in [('answer', gif_answer), ('hover', gif_hover), ('finishing', gif_finishing)]:
            if not only or name in only:
                size = gif(fn(tmp), os.path.join(OUT, 'gifs', name + '.gif'))
                print(f'{name}.gif {size / 1e6:.2f} MB')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
