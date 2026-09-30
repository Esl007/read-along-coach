"""Assemble the submission video from cards, voice-over and a real demo recording.

The demo segment is the real app, captured at 2x by record.mjs. It is framed on
the ink background with a band underneath that carries the captions and a
speaker chip ("Reader" / "Coach"), so nothing ever covers the passage. It opens
on a wide shot of the whole app, then crossfades to a close-up of the stage
column (title, patience pill, passage, coach bubble, legend) so the words stay
legible on a laptop or phone. Captions come from the app's own state changes;
the chips come from the log of clips the page actually played.

Rendered in separate light passes (wide, close-up, composite): one graph holding
both 3200x1800 branches plus the overlays was killed for memory.
"""
import json, os, subprocess, sys, urllib.parse
import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
APP = os.path.expanduser('~/read-along-coach')
REC = sys.argv[1] if len(sys.argv) > 1 else 'rec'
FPS = 30
INK = '0x1B2330'
VO = json.load(open('vo/durations.json'))
L = json.load(open(f'{REC}/log.json'))
os.makedirs('seg', exist_ok=True)

WIN_X, WIN_Y, WIN_W, WIN_H = 160, 28, 1600, 900   # app window inside the 1920x1080 frame
CROP = (2064, 1160, 940, 192)                      # close-up, source px at 2x == CSS 1032x580 at (470, 96)
BAND_Y = WIN_Y + WIN_H                             # caption band 928..1080
LIGHT = ['-threads', '4', '-filter_threads', '2']


def run(args):
    r = subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-y', *args], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr[-4000:])


def still(name, img, dur, zoom=True):
    n = int(round(dur * FPS))
    vf = (f"scale=3840:2160,zoompan=z='min(1+0.00045*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s=1920x1080:fps={FPS}"
          if zoom else f"scale=1920:1080,fps={FPS}")
    vf += f",fade=t=in:st=0:d=0.35:color={INK},fade=t=out:st={dur-0.35:.3f}:d=0.35:color={INK},format=yuv420p"
    run([*LIGHT, '-loop', '1', '-i', img, '-t', f'{dur:.3f}', '-vf', vf, '-r', str(FPS),
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', f'seg/{name}.mp4'])


# ── demo window ──────────────────────────────────────────────────────────────
click = L['clickAt'] / 1000
start = click - 1.2                          # a beat of the idle app first
rec_end = L['endAt'] / 1000
frames = [f for f in L['frames'] if f['t'] >= start - 0.3]
lines = []
for i, f in enumerate(frames):
    nxt = frames[i + 1]['t'] if i + 1 < len(frames) else rec_end
    lines += [f"file '{os.path.abspath(f['f'])}'", f"duration {max(nxt - max(f['t'], start), 0.001):.4f}"]
lines.append(f"file '{os.path.abspath(frames[-1]['f'])}'")
open('seg/demo.txt', 'w').write('\n'.join(lines) + '\n')

demo_len = rec_end - start
report_at = L['doneAt'] / 1000 - start       # report rendered
hold = max(VO['04_report'] + 0.2 - (demo_len - report_at) + 1.0, 1.0)
total_demo = demo_len + hold
A = (click - start) + 1.0                    # crossfade wide -> close-up
XF = 0.8

caps = [c for c in L['captions'] if c['text']]
cap_iv = []
for i, c in enumerate(caps):
    s = c['at'] / 1000 - start
    e = min(caps[i + 1]['at'] / 1000 - start if i + 1 < len(caps) else s + 4.5, s + 4.5)
    cap_iv.append((max(s, 0), e))

opens, spans = {}, []
for e in L['audioLog']:
    if e['ev'] == 'play':
        opens.setdefault(e['src'], []).append(e['at'] / 1000)
    elif e['ev'] == 'stop' and opens.get(e['src']):
        s0 = opens[e['src']].pop(0)
        path = urllib.parse.unquote(urllib.parse.urlparse(e['src']).path)
        spans.append(('reader' if '/voices/phrases/' in path else 'coach', s0 - start, e['at'] / 1000 - start, path))
spans = [s for s in spans if s[2] > 0]


def enable(ivs):
    return '+'.join(f'between(t,{a:.3f},{b:.3f})' for a, b in ivs) or '0'


reader_iv = [(a, b + 0.15) for k, a, b, _ in spans if k == 'reader']
coach_iv = [(a, b + 0.6) for k, a, b, _ in spans if k == 'coach']
cw, ch, cx, cy = CROP

# Pass 1: wide shot. Pass 2: close-up. Each scaled to the window on its own.
run([*LIGHT, '-f', 'concat', '-safe', '0', '-i', 'seg/demo.txt', '-vf',
     f"fps={FPS},scale={WIN_W}:{WIN_H}:flags=lanczos,trim=0:{A + XF:.3f},setpts=PTS-STARTPTS,format=yuv420p",
     '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-r', str(FPS), 'seg/wide.mp4'])
run([*LIGHT, '-f', 'concat', '-safe', '0', '-i', 'seg/demo.txt', '-vf',
     f"fps={FPS},crop={cw}:{ch}:{cx}:{cy},scale={WIN_W}:{WIN_H}:flags=lanczos,trim=start={A:.3f},setpts=PTS-STARTPTS,"
     f"tpad=stop_mode=clone:stop_duration={hold:.3f},format=yuv420p",
     '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-r', str(FPS), 'seg/close.mp4'])

# Pass 3: crossfade, frame, band overlays.
ins = ['-i', 'seg/wide.mp4', '-i', 'seg/close.mp4']
for img in ['ov/frame.png', 'ov/chip-reader.png', 'ov/chip-coach.png'] + [f'ov/cap{i}.png' for i in range(len(caps))]:
    ins += ['-loop', '1', '-framerate', str(FPS), '-t', f'{total_demo:.3f}', '-i', img]
fc = [
    f"[0:v]fps={FPS},settb=AVTB[wide]",
    f"[1:v]fps={FPS},settb=AVTB[close]",
    f"[wide][close]xfade=transition=fade:duration={XF}:offset={A:.3f},format=yuv420p[app]",
    f"color=c={INK}:s=1920x1080:r={FPS}:d={total_demo:.3f}[bg]",
    f"[bg][app]overlay={WIN_X}:{WIN_Y}:shortest=1[v0]",
    "[v0][2:v]overlay=0:0[v1]",
    f"[v1][3:v]overlay=1340:{BAND_Y + 34}:enable='{enable(reader_iv)}'[v2]",
    f"[v2][4:v]overlay=1340:{BAND_Y + 34}:enable='{enable(coach_iv)}'[v3]",
]
last = 'v3'
for i, iv in enumerate(cap_iv):
    fc.append(f"[{last}][{5 + i}:v]overlay={WIN_X + 8}:{BAND_Y + 6}:enable='{enable([iv])}'[c{i}]")
    last = f'c{i}'
fc.append(f"[{last}]fade=t=in:st=0:d=0.3:color={INK},format=yuv420p[vout]")
run([*LIGHT, *ins, '-filter_complex', ';'.join(fc), '-map', '[vout]', '-t', f'{total_demo:.3f}',
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-r', str(FPS), 'seg/demo.mp4'])

# Intro still: the idle app in the same frame as the demo's opening wide shot.
idle = [f for f in L['frames'] if f['t'] < L['captions'][0]['at'] / 1000][-1]['f']
run(['-i', idle, '-i', 'ov/frame.png', '-filter_complex',
     f"[0:v]scale={WIN_W}:{WIN_H}:flags=lanczos,pad=1920:1080:{WIN_X}:{WIN_Y}:color={INK}[a];[a][1:v]overlay=0:0",
     '-frames:v', '1', 'seg/intro.png'])

PAD = 1.3
plan = [
    ('s1', 'still', 'cards/title.png', '01_title', True),
    ('s2', 'still', 'cards/problem.png', '02_problem', True),
    ('s3', 'still', 'seg/intro.png', '03_intro', False),
    ('demo', 'demo', None, None, False),
    ('s5', 'still', 'cards/fair.png', '05_fair', True),
    ('s6', 'still', 'cards/arch.png', '06_arch', True),
    ('s7', 'still', 'cards/value.png', '07_value', True),
    ('s8', 'still', 'cards/close.png', '08_close', True),
]
audio, order, t = [], [], 0.0
for name, kind, src, vo, zoom in plan:
    if kind == 'still':
        dur = VO[vo] + PAD + (2.2 if name == 's8' else 0)
        still(name, src, dur, zoom)
        audio.append((f'vo/{vo}.wav', t + 0.5, None, 1.0))
    else:
        dur = total_demo
        for k, a, b, path in spans:
            audio.append((APP + path, t + a, b - a, 0.95 if k == 'coach' else 0.85))
        audio.append(('vo/04_report.wav', t + report_at + 0.2, None, 1.0))
    order.append(f'seg/{name}.mp4')
    t += dur
total = t

cin, cf = [], []
for i, p in enumerate(order):
    cin += ['-i', p]
    cf.append(f"[{i}:v]scale=1920:1080,setsar=1,fps={FPS},format=yuv420p[v{i}]")
cf.append(''.join(f'[v{i}]' for i in range(len(order))) + f"concat=n={len(order)}:v=1:a=0[v]")
run([*LIGHT, *cin, '-filter_complex', ';'.join(cf), '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
     '-r', str(FPS), 'seg/video.mp4'])

ai, fl = [], []
for i, (f, off, mx, g) in enumerate(audio):
    ai += ['-i', f]
    trim = f"atrim=0:{mx:.3f}," if mx else ''
    fl.append(f"[{i}:a]{trim}aformat=sample_rates=48000:channel_layouts=stereo,volume={g},adelay={int(off*1000)}:all=1[a{i}]")
fl.append(''.join(f'[a{i}]' for i in range(len(audio))) +
          f"amix=inputs={len(audio)}:normalize=0:dropout_transition=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[out]")
run([*ai, '-filter_complex', ';'.join(fl), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', 'seg/audio.wav'])
run(['-i', 'seg/video.mp4', '-i', 'seg/audio.wav', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
     '-movflags', '+faststart', 'read-along-coach-demo.mp4'])
print(json.dumps({'total_s': round(total, 1), 'demo_s': round(total_demo, 1), 'crossfade_at': round(A, 2),
                  'reader_spans': len(reader_iv), 'coach_spans': len(coach_iv), 'captions': len(cap_iv)}))
