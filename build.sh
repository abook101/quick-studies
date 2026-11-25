#!/usr/bin/env bash
# Copies course card files written by the content threads into the app and rebuilds cards/index.json.
# Usage: ./build.sh   (run from anywhere)
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-/mnt/project-files/cards}"
if [ -d "$SRC" ]; then
  for f in "$SRC"/*.json; do [ -e "$f" ] || continue; python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['cards']" "$f" && cp "$f" "$APP/cards/"; done
fi
python3 - "$APP/cards" <<'PY'
import json, os, sys
d = sys.argv[1]
files = sorted(f for f in os.listdir(d) if f.endswith('.json') and f != 'index.json')
seen, n = set(), 0
for f in files:
    for c in json.load(open(os.path.join(d, f)))['cards']:
        if c['id'] in seen: print('duplicate id', c['id'], 'in', f)
        seen.add(c['id']); n += 1
json.dump({'files': files}, open(os.path.join(d, 'index.json'), 'w'))
print(len(files), 'files,', n, 'cards')
PY
# bump the service worker cache name so phones pick up the new version
sed -i "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$(date +%Y-%m-%d\ %H:%M)'/" "$APP/app.js"
sed -i "s/const CACHE = 'qs-[^']*'/const CACHE = 'qs-$(date +%Y%m%d%H%M)'/" "$APP/sw.js"
