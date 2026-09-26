"""Every `path:line[-line]` anchor in docs/trust-model.md must name a tracked
file whose line count covers the cited line. A bare basename (the document's
short form after a full path in the same sentence) resolves when exactly one
tracked file has that basename. Prints the misses; exit 1 if any.

No extension allowlist (Codex on #1444): a path is anything with a directory
separator, or a bare name with an alphabetic extension. `Server/Dockerfile:13`
and `foo.sh:25-26` count; `8.8.8.8:80` does not."""
import os, re, subprocess, sys

doc = open("docs/trust-model.md", encoding="utf-8").read()
tracked = [p for p in subprocess.check_output(["git", "ls-files"], text=True).split("\n") if p]
tracked_set = set(tracked)
by_base = {}
for p in tracked:
    by_base.setdefault(os.path.basename(p), []).append(p)
pat = re.compile(
    r"`((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:-(\d+))?"
)
seen, short, bad = 0, 0, []
for m in pat.finditer(doc):
    path, lo, hi = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
    seen += 1
    if path not in tracked_set:
        cands = by_base.get(path, [])
        if len(cands) != 1:
            bad.append(f"{path}:{lo} -- {'ambiguous ' + str(cands) if cands else 'not a tracked file'}")
            continue
        path = cands[0]
        short += 1
    n = sum(1 for _ in open(path, encoding="utf-8", errors="replace"))
    if hi > n:
        bad.append(f"{path}:{lo}-{hi} -- file has {n} lines")
print(f"{seen} path:line anchors checked ({short} short-form resolved by unique basename), {len(bad)} unresolvable")
for b in bad:
    print("  " + b)
sys.exit(1 if bad else 0)
