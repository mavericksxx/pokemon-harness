#!/usr/bin/env python3
"""Build demo/index.html (one self-contained file) from tools/demo/template.html plus the garden map, tilesets and dex data. Run: python3 tools/demo/build.py"""
import base64, json, sys, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
HERE = os.path.dirname(os.path.abspath(__file__))

m = json.load(open(f'{ROOT}/src/renderer/src/scene/garden/maps/garden.tmj'))
W, H = m['width'], m['height']
L = {l['name']: l for l in m['layers']}

def b64(path):
    return 'data:image/png;base64,' + base64.b64encode(open(path, 'rb').read()).decode()

tilesets = []
anims = {}
for t in m['tilesets']:
    tilesets.append({'firstgid': t['firstgid'], 'columns': t['columns'], 'tilecount': t['tilecount'],
                     'image': b64(f"{ROOT}/assets/{t['image']}")})
    for tt in t.get('tiles', []):
        if 'animation' in tt:
            anims[t['firstgid'] + tt['id']] = [t['firstgid'] + fr['tileid'] for fr in tt['animation']]

spawns = {o['name']: [o['x'] // 16, o['y'] // 16] for o in L['spawn-points']['objects']}
zones = [{'name': o['name'], 'type': o.get('type', ''), 'x': o['x'] // 16, 'y': o['y'] // 16,
          'w': o['width'] // 16, 'h': o['height'] // 16} for o in L['zones']['objects']]

dex = json.load(open(f'{ROOT}/assets/dex/dexIndex.json'))
animated = {e['id'] for e in dex.values() if e['num'] <= 649 and e.get('hasSprite') and not e.get('static')}
species = []
for e in sorted(dex.values(), key=lambda e: e['num']):
    if e['id'] not in animated: continue
    species.append([e['id'], e['name'], e['num'], e['line'], e['stage'],
                    [x for x in e['evolvesTo'] if x in animated], e['locomotion']])

data = {
    'W': W, 'H': H, 'tile': 16,
    'layers': {k: L[k]['data'] for k in ['floor', 'walls', 'furniture-below', 'furniture-above', 'collision', 'water']},
    'tilesets': tilesets, 'anims': anims, 'animMs': 180,
    'spawns': spawns, 'zones': zones, 'species': species,
}
tpl = open(f'{HERE}/template.html').read()
out = tpl.replace('/*__DEMO_DATA__*/', 'const DEMO_DATA = ' + json.dumps(data, separators=(',', ':')) + ';')
os.makedirs(f'{ROOT}/demo', exist_ok=True)
open(f'{ROOT}/demo/index.html', 'w').write(out)
print('wrote demo/index.html', len(out) // 1024, 'KB', 'species', len(species))
