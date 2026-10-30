"""Build Freestyle into one self-contained page.

    python build.py

Joins app/shell.html with the modules in app/ and the built-in example, and writes index.html.
There is no other tooling: open index.html in a browser, or host that one file anywhere.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULES = ["engine.js", "render.js", "export.js", "pdf.js", "app.js"]


def main():
    sample = json.loads((HERE / "examples" / "coffee-orders.map.json").read_text(encoding="utf-8"))
    script = "const SAMPLE_MAP = " + json.dumps(sample, ensure_ascii=True, separators=(",", ":")) + ";\n\n"
    script += "\n\n".join((HERE / "app" / name).read_text(encoding="utf-8").rstrip() for name in MODULES) + "\n"
    assert "</script" not in script.lower(), "a module contains a closing script tag"
    page = (HERE / "app" / "shell.html").read_text(encoding="utf-8")
    assert page.count("/*@@APP@@*/") == 1
    page = page.replace("/*@@APP@@*/", script)
    (HERE / "index.html").write_bytes(page.encode("utf-8"))
    print(f"index.html {len(page) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
