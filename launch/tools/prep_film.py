"""Utility: crops + retimed sequences for the full film acts (CSS px rects, plates DPR 2)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prep_proof import load, cut, save, sequence, MAIN, TERM, UI, PILL

def piece(name, plate, rect=MAIN):
    save(cut(load(plate), rect), UI, name + ".png")

piece("cb_main", "code_browser_site")
piece("acc_main", "accounts_scrolled")
piece("nt0_main", "nt_0"); piece("nt1_main", "nt_1"); piece("nt2_main", "nt_2")
piece("sw_main", "switch_ws")
piece("t2_main", "term_second")
piece("dash_main", "dashlive2/000")
piece("told_main", "v_tell/after_015")
piece("cb_side", "code_browser_site", (0, 0, 240, 960))
CARDS = {"card_download": (272, 301, 579, 551), "card_waveform": (272, 587, 579, 812),
         "card_updater": (591, 587, 898, 812), "card_browser": (911, 587, 1218, 812)}
for n, r in CARDS.items():
    piece(n, "dashlive2/000", r)
sequence("dash_live", [f"dashlive2/{i:03d}" for i in range(48)], MAIN, 4)
sequence("nt_type", [f"nt_type/{i:03d}" for i in range(24)], MAIN, 3)
sequence("push", [f"push/{i:03d}" for i in range(14)], TERM, 5)
