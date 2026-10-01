"""Utility: retimed sequences for the multi-session coding act and the Providers act
(capture/plates/panes, from capture/capture_panes.mjs). Rects are CSS px; plates are DPR 2."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prep_proof import MAIN, sequence

# 4 panes (2 x 2) and 6 panes (3 x 2): each pane's rect in CSS px
FOUR = [(249, 101, 916, 508), (924, 101, 1592, 508), (249, 516, 916, 924), (924, 516, 1592, 924)]
COLS = [(249, 692), (700, 1142), (1149, 1592)]
ROWS = [(101, 508), (516, 924)]
SIX = [(x0, y0, x1, y1) for (y0, y1) in ROWS for (x0, x1) in COLS]

if __name__ == "__main__":
    # the agents finish by capture 11-12 (screenshots are slower than the stream), so each streamed
    # capture is held 16-18 film frames: they visibly work through the whole shot, then hold done
    four = ["panes/four_ready"] + [f"panes/four/{i:03d}" for i in range(13)]
    sequence("four", four, MAIN, [12] + [16] * 13)
    for k, r in enumerate(FOUR):
        sequence(f"four_p{k}", four, r, [12] + [16] * 13)
    six = ["panes/six_ready"] + [f"panes/six/{i:03d}" for i in range(12)]
    sequence("six", six, MAIN, [10] + [18] * 12)
    sequence("prov", [f"panes/prov_scroll/{i:03d}" for i in range(31)], MAIN, 4)
