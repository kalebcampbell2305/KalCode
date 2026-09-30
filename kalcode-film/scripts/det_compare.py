import sys, json
import numpy as np
from PIL import Image
res = []
for f in sys.argv[1:]:
    a = np.asarray(Image.open(f"build/det_{f}_a.png").convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(f"build/det_{f}_b.png").convert("RGB"), dtype=np.int16)
    m = np.asarray(Image.open(f"build/det_{f}_film.png").convert("RGB"), dtype=np.int16)
    res.append({"frame": int(f), "stillVsStill_maxDiff": int(np.abs(a - b).max()), "stillVsFilm_meanDiff": round(float(np.abs(a - m).mean()), 3)})
print(json.dumps(res, indent=1))
open("out/determinism.json", "w").write(json.dumps(res, indent=1))
# stills must be pixel-identical; still vs film is bounded by CRF-16 encode error, which reaches ~1.6 on a
# dense keyframe (chunked renders open every chunk on one). A frame off by one measures 3.5+.
ok = all(r["stillVsStill_maxDiff"] == 0 and r["stillVsFilm_meanDiff"] < 2.0 for r in res)
print("DETERMINISM", "PASS" if ok else "FAIL")
