#!/bin/sh
# Resumable chunked render of film.blend -> render/film/####.png
cd "$(dirname "$0")/.."
B="/c/Program Files/Blender Foundation/Blender 5.1/blender.exe"
OUT="$(cygpath -w "$PWD/render/film")"
export KC_SKIP_EXISTING=1
for a in 0 450 900 1350 1800 2250 2700 3150; do
  b=$((a + 449))
  "$B" -b blender/film.blend -P tools/render.py -- "$OUT" "$a-$b" 2>&1 | grep -E "RENDERED|rror" | sed "s/^/[$a-$b] /"
done
ls render/film | wc -l
