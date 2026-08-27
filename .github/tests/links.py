# README anchors and relative paths, plus the landing page's links into the
# README. The README is the Marketplace listing and the landing page points at
# its section anchors, so a renamed heading breaks a page nobody would think to
# re-check. Driven by run.sh.
import re, os, sys, pathlib
root = pathlib.Path(sys.argv[1])
md = (root / "README.md").read_text()

# heading anchors GitHub would generate, plus explicit <a id="...">
anchors = set()
for h in re.findall(r'^#{1,6}\s+(.*)$', md, re.M):
    a = h.strip().lower()
    a = re.sub(r'[^\w\s-]', '', a)
    anchors.add(re.sub(r'\s+', '-', a))
anchors |= set(re.findall(r'<a id="([^"]+)"', md))

bad = []
for text, target in re.findall(r'\[([^\]]*)\]\(([^)]+)\)', md):
    if target.startswith(('http://', 'https://', 'mailto:')):
        continue
    if target.startswith('#'):
        if target[1:] not in anchors:
            bad.append(f"README.md: dead anchor {target}  (in [{text}])")
    else:
        p = (root / target.split('#')[0])
        if not p.exists():
            bad.append(f"README.md: missing path {target}  (in [{text}])")

# landing page -> README anchors
html = (root / "docs/index.html").read_text()
for target in re.findall(r'href="https://github\.com/KeunwooPark/cluedoc(#[^"]+)"', html):
    if target[1:] not in anchors:
        bad.append(f"docs/index.html: dead README anchor {target}")
for target in re.findall(r'href="https://github\.com/KeunwooPark/cluedoc/tree/main/([^"#]+)"', html):
    if not (root / target).exists():
        bad.append(f"docs/index.html: missing path {target}")

print("\n".join(bad) if bad else f"all internal links resolve ({len(anchors)} anchors)")
sys.exit(1 if bad else 0)
