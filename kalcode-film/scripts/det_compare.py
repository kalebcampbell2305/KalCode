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
ok = all(r["stillVsStill_maxDiff"] == 0 and r["stillVsFilm_meanDiff"] < 1.5 for r in res)
print("DETERMINISM", "PASS" if ok else "FAIL")
