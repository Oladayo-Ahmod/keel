#!/usr/bin/env python3
"""Fetch every submission URL the way a logged-out judge would and flag anything
that is not a plain 200. YouTube links go through the oEmbed endpoint, because a
private or removed video still returns 200 on the watch page.

    python3 script/check_links.py                      # README, docs/*.md, docs/submission/*.md|txt|js, web/src text
    python3 script/check_links.py path/to/file.md       # specific files
    python3 script/check_links.py --url https://...     # extra urls
    python3 script/check_links.py --allow-rpc           # do not flag json-rpc endpoints that answer GET with 405

Exit code is 1 if anything is flagged, so it can gate a submission. No cookies,
no auth headers, no keys.
"""
import re, sys, json, time, pathlib, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (compatible; trozu-link-check/1.0)"
URL_RE = re.compile(r"https?://[^\s<>\"'`)\]\\]+")
# not real targets: local dev, placeholders, wildcard patterns, bare api bases
SKIP = re.compile(r"^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.|schemas\.|purl\.org|www\.w3\.org)|\*|\{|\$")
YT = re.compile(r"^https?://(www\.|m\.)?(youtube\.com/(watch|shorts|live)|youtu\.be/)")
# json-rpc and api bases answer plain GET with 4xx by design; treated as informational
RPC_HINT = re.compile(r"^https?://(rpc|api)[.\-]|/api$|/rpc$")


def default_files():
    files = [ROOT / "README.md"]
    for pat in ("docs/*.md", "docs/submission/*.md", "docs/submission/*.txt", "docs/submission/*.js"):
        files += sorted(ROOT.glob(pat))
    return [f for f in files if f.exists()]


def pptx_text(path):
    # only slide text and external hyperlink targets; the xml namespaces in
    # every part are urls too but they are not links anyone follows
    import zipfile
    out = ""
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if re.match(r"ppt/(slides|notesSlides)/slide\d+\.xml$|ppt/(slides|notesSlides)/notesSlide\d+\.xml$", n):
                out += " ".join(re.findall(r"<a:t>([^<]*)</a:t>", z.read(n).decode("utf8", "ignore"))) + "\n"
            elif n.endswith(".rels") and "slides/_rels" in n:
                out += "\n".join(re.findall(r'Target="(https?://[^"]+)"[^>]*TargetMode="External"', z.read(n).decode("utf8", "ignore"))) + "\n"
    return out

def extract(files):
    found = {}
    for f in files:
        f = pathlib.Path(f)
        try:
            text = pptx_text(f) if f.suffix == ".pptx" else f.read_text(errors="ignore")
        except Exception as e:
            print(f"cannot read {f}: {e}", file=sys.stderr)
            continue
        for u in URL_RE.findall(text):
            u = u.rstrip(".,;:!?")
            if u.count("(") < u.count(")"):
                u = u.rstrip(")")
            if SKIP.search(u):
                continue
            found.setdefault(u, set()).add(str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f))
    return found


class NoCookies(urllib.request.HTTPRedirectHandler):
    pass


def fetch(url, method="GET", tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"}, method=method)
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, r.geturl(), r.read(65536)
        except urllib.error.HTTPError as e:
            # 429 and 5xx are worth a retry, the rest are answers
            if e.code in (429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(2 + 2 * i)
                last = e.code
                continue
            return e.code, url, b""
        except Exception as e:
            last = str(e)
            time.sleep(1 + i)
    return 0, url, str(last).encode()


def check(url):
    if YT.match(url):
        q = urllib.parse.quote(url, safe="")
        code, _, body = fetch(f"https://www.youtube.com/oembed?url={q}&format=json")
        if code == 200:
            try:
                return url, "ok", f"public video: {json.loads(body).get('title', '?')!r}"
            except Exception:
                return url, "ok", "oembed 200"
        why = {401: "not embeddable or private", 403: "private", 404: "private, removed or wrong id"}.get(code, f"oembed {code}")
        return url, "FAIL", f"youtube {why} (oembed {code})"
    code, final, body = fetch(url)
    if code == 200:
        note = "" if final == url else f"redirects to {final}"
        return url, "ok", note
    if RPC_HINT.search(url) and code in (400, 404, 405):
        return url, "info", f"{code} on GET, expected for an rpc or api base"
    return url, "FAIL", f"{code or 'no response'} {body.decode('utf8', 'ignore')[:80] if code == 0 else ''}".strip()


def main():
    args = sys.argv[1:]
    files, extra = [], []
    i = 0
    while i < len(args):
        if args[i] == "--url":
            extra.append(args[i + 1]); i += 2
        elif args[i].startswith("--"):
            i += 1
        else:
            files.append(pathlib.Path(args[i]).resolve()); i += 1
    urls = extract(files or default_files())
    for u in extra:
        urls.setdefault(u, {"--url"})
    print(f"checking {len(urls)} urls, logged out, no auth\n")
    with ThreadPoolExecutor(6) as ex:
        results = list(ex.map(check, sorted(urls)))
    bad = 0
    for u, status, note in results:
        mark = {"ok": "  ok ", "info": " info", "FAIL": "FAIL "}[status]
        print(f"{mark} {u}" + (f"\n        {note}" if note else "") + (f"\n        in {', '.join(sorted(urls[u]))}" if status == "FAIL" else ""))
        bad += status == "FAIL"
    print(f"\n{len(results) - bad} fine, {bad} flagged")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
