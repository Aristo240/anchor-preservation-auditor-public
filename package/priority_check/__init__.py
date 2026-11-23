"""priority_check: a paired final-decision test for your own AI decision step (offline-capable, standard library).
See README.md. The `run` command is a final-step ablation; the `chain` command (priority_check.chain) runs a fixed six-handoff workflow."""
from .core import (Decision, Variant, build_prompt, parse_strict, parse_tolerant, variants, run, summarise,
                   write_outputs, write_summary, prepare_out_dir, RecordWriter, render_md)

__all__ = ["Decision", "Variant", "build_prompt", "parse_strict", "parse_tolerant", "variants", "run", "summarise",
           "write_outputs", "write_summary", "prepare_out_dir", "RecordWriter", "render_md"]
__version__ = "0.1.0b1"
