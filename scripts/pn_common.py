#!/usr/bin/env python3
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


TARGET = Path(__file__).resolve().parents[1] / "SKILL" / "PaperNexus" / "scripts" / "pn_common.py"
SPEC = spec_from_file_location("papernexus_skill_pn_common", TARGET)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load compatibility module from {TARGET}")
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

for name in dir(MODULE):
    if not name.startswith("_"):
        globals()[name] = getattr(MODULE, name)
