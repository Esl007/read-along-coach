import json, os, subprocess, urllib.parse
import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()
APP = os.path.expanduser('~/read-along-coach')
FPS = 30
VO = json.load(open('vo/durations.json'))
L = json.load(open('rec-halting/log.json'))
os.makedirs('seg', exist_ok=True)

def run(args):
    r = subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-y', *args], capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr[-3000:])

INK = '0x1B2330'
def still(name, img, dur, zoom=True):
    n = int(round(dur * FPS))
    vf = (f"scale=3840:2160,zoompan=z='min(1+0.00045*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s=1920x1080:fps={FPS}"
          if zoom else f"scale=1920:1080,fps={FPS}")
    vf += f",fade=t=in:st=0:d=0.35:color={INK},fade=t=out:st={dur-0.35:.3f}:d=0.35:color={INK},format=yuv420p"
    run(['-loop', '1', '-i', img, '-t', f'{dur:.3f}', '-vf', vf, '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', f'seg/{name}.mp4'])

# ---- demo recording window --------------------------------------------------
t0 = L['t0'] / 1000
start = t0 + 1.2                       # just before the first caption and the click
frames = [f for f in L['frames'] if f['t'] >= start - 0.2]
rec_end = L['endAt'] / 1000
lines = []
for i, f in enumerate(frames):
    nxt = frames[i + 1]['t'] if i + 1 < len(frames) else rec_end
    d = max(nxt - max(f['t'], start), 0.001)
    lines += [f"file '{os.path.abspath(f['f'])}'", f"duration {d:.4f}"]
lines.append(f"file '{os.path.abspath(frames[-1]['f'])}'")
open('seg/demo.txt', 'w').write('\n'.join(lines) + '\n')
demo_len = rec_end - start
scroll_at = (L['doneAt'] / 1000 + 2.2) - start      # when the report scrolls into view
report_at = (L['doneAt'] / 1000) - start             # when the report is rendered
hold = max(VO['04_report'] + 0.2 - (demo_len - report_at) + 1.2, 1.0)
run(['-f', 'concat', '-safe', '0', '-i', 'seg/demo.txt',
     '-vf', f"scale=1920:1080,fps={FPS},tpad=stop_mode=clone:stop_duration={hold:.3f},fade=t=in:st=0:d=0.3:color={INK},format=yuv420p",
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', 'seg/demo.mp4'])
demo_total = demo_len + hold

# ---- intro still: the idle app, first recorded frame -------------------------
# the last frame captured BEFORE the first caption appeared (the recorder only
# emits frames on change, so "nearest to t" can land after the caption)
first_cap = L['captions'][0]['at'] / 1000
intro_frame = [f for f in L['frames'] if f['t'] < first_cap][-1]['f']

PAD = 1.3
plan = [  # (segment name, kind, source, vo key)
  ('s1', 'still', 'cards/title.png', '01_title'),
  ('s2', 'still', 'cards/problem.png', '02_problem'),
  ('s3', 'still', intro_frame, '03_intro'),
  ('s4', 'demo', None, None),
  ('s5', 'still', 'cards/fair.png', '05_fair'),
  ('s6', 'still', 'cards/arch.png', '06_arch'),
  ('s7', 'still', 'cards/value.png', '07_value'),
  ('s8', 'still', 'cards/close.png', '08_close'),
]
audio = []   # (file, offset_s, max_dur or None, gain)
t = 0.0
order = []
for name, kind, src, vo in plan:
    if kind == 'still':
        dur = VO[vo] + PAD + (2.2 if name == 's8' else 0)
        still(name, src, dur)
        audio.append((f'vo/{vo}.wav', t + 0.5, None, 1.0))
    else:
        dur = demo_total
        # app audio from the playback log, at its real moment
        opens = {}
        for e in L['audioLog']:
            if e['ev'] == 'play': opens.setdefault(e['src'], []).append(e['at'] / 1000)
            elif e['ev'] == 'stop' and opens.get(e['src']):
                s0 = opens[e['src']].pop(0)
                if s0 >= start:
                    p = urllib.parse.urlparse(e['src']).path
                    audio.append((APP + urllib.parse.unquote(p), t + (s0 - start), e['at'] / 1000 - s0, 0.9))
        audio.append(('vo/04_report.wav', t + report_at + 0.2, None, 1.0))
    order.append('seg/demo.mp4' if kind == 'demo' else f'seg/{name}.mp4'); t += dur
total = t
open('seg/list.txt', 'w').write(''.join(f"file '{os.path.abspath(p)}'\n" for p in order))
# Join with the concat FILTER and one re-encode, normalising size/SAR/fps on
# every input. (A missing segment now fails loudly here instead of silently
# truncating the video, which is what the stream-copy join did.)
cin, cf = [], []
for i, p in enumerate(order):
    cin += ['-i', p]
    cf.append(f"[{i}:v]scale=1920:1080,setsar=1,fps={FPS},format=yuv420p[v{i}]")
cf.append(''.join(f'[v{i}]' for i in range(len(order))) + f"concat=n={len(order)}:v=1:a=0[v]")
run([*cin, '-filter_complex', ';'.join(cf), '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-r', str(FPS), 'seg/video.mp4'])

# ---- one audio timeline ------------------------------------------------------
ins, fl = [], []
for i, (f, off, mx, g) in enumerate(audio):
    ins += ['-i', f]
    trim = f"atrim=0:{mx:.3f}," if mx else ''
    fl.append(f"[{i}:a]{trim}aformat=sample_rates=48000:channel_layouts=stereo,volume={g},adelay={int(off*1000)}:all=1[a{i}]")
fl.append(''.join(f'[a{i}]' for i in range(len(audio))) + f"amix=inputs={len(audio)}:normalize=0:dropout_transition=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[out]")
run([*ins, '-filter_complex', ';'.join(fl), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', 'seg/audio.wav'])
run(['-i', 'seg/video.mp4', '-i', 'seg/audio.wav', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'read-along-coach-demo.mp4'])
print(json.dumps({'total_s': round(total, 1), 'demo_s': round(demo_total, 1), 'app_clips': sum(1 for a in audio if a[0].startswith(APP)), 'vo': sum(1 for a in audio if a[0].startswith('vo/'))}))
