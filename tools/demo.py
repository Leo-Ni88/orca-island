#!/usr/bin/env python3
"""Renders demo frames with the real helper, off-screen, from demo/demo-data.json only.

It never talks to Orca and never reads the screen: the helper draws its own view into PNGs.
Usage: tools/demo.py <scene> <out-dir>   (scenes: see SCENES)
"""
import json, os, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.environ.get('ISLAND_HELPER', os.path.join(ROOT, 'helper', 'bin', 'island-helper'))
DATA = json.load(open(os.path.join(ROOT, 'demo', 'demo-data.json')))
NOW = 1_800_000_000_000  # fixed demo clock (ms)
SLOW = float(os.environ.get('ISLAND_SLOW', '8'))  # demo recording: motion runs this much slower, frames keep pace


class Helper:
    def __init__(self):
        env = dict(os.environ, ISLAND_OFFSCREEN='1', ISLAND_ALLOW_CAPTURE='1', ISLAND_LOCK_PATH='/tmp/orca-island-demo.lock')
        self.p = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        self.msgs = []
        threading.Thread(target=lambda: [self.msgs.append(json.loads(l)) for l in self.p.stdout], daemon=True).start()
        self.send({'type': 'hello', 'orca': {'bundleId': 'none'}, 'config': {'hotkey': False, 'answerGranted': True, 'allowAnswer': True, 'hideFromCapture': False}})
        self.send({'type': 'demo_clock', 'now': NOW, 'slow': SLOW})

    def send(self, m):
        self.p.stdin.write(json.dumps({'v': 1, **m}) + '\n'); self.p.stdin.flush()

    def wait(self, kind, after, timeout=60):
        t = time.time()
        while time.time() - t < timeout:
            x = [m for m in self.msgs[after:] if m['type'] == kind]
            if x: return x[0]
            time.sleep(0.02)
        raise SystemExit(f'no {kind}')

    def record(self, out, seconds, fps=30):
        os.makedirs(out, exist_ok=True)
        n = len(self.msgs)
        self.send({'type': 'record', 'dir': out, 'fps': fps, 'frames': int(seconds * fps), 'scale': 2})
        return n

    def snap(self, path):
        n = len(self.msgs)
        self.send({'type': 'snap', 'path': path, 'lit': True}); self.wait('snapped', n)

    def act(self, a, **d):
        self.send({'type': 'debug_act', 'action': a, 'data': d})

    def close(self):
        self.p.stdin.close(); self.p.wait(5)


def item(i, unread=None):
    it = dict(i)
    it['startedAt'] = NOW - 1000 * (i.get('workSec', 0) + i.get('ageSec', 0))
    it['stateSince'] = NOW - 1000 * i.get('ageSec', 0)
    it['unread'] = i.get('unread', i['state'] == 'needs_you') if unread is None else unread
    it.setdefault('options', []); it.setdefault('reply', False); it.setdefault('isNew', False)
    return it


def groups(mode):
    return [dict(g, counts=counts(g), collapsed=False) for g in DATA['groups'][mode]]


def counts(g):
    c = {'needs_you': 0, 'failed': 0, 'done': 0, 'working': 0}
    by = {i['id']: i for i in DATA['items']}
    for s in g['sections']:
        for i in s['ids']:
            x = by[i]
            k = x['state'] if x['state'] in c else 'done'
            c[k] += 1
    return c


def load(h, ids=None, mode='project'):
    for i in DATA['items']:
        if ids is None or i['id'] in ids: h.send({'type': 'upsert', 'item': item(i)})
    h.send({'type': 'groups', 'mode': mode, 'groups': groups(mode)})


def detail(h, id):
    d = dict(DATA['details'][id]); d.update(type='detail', id=id); h.send(d)
