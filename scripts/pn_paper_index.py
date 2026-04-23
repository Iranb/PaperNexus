#!/usr/bin/env python3
from pathlib import Path
import runpy
import sys


TARGET = Path(__file__).resolve().parents[1] / "SKILL" / "PaperNexus" / "scripts" / "pn_paper_index.py"
sys.path.insert(0, str(TARGET.parent))
runpy.run_path(str(TARGET), run_name="__main__")
