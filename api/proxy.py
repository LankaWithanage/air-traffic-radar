#!/usr/bin/env python3
"""Air Traffic Radar API for your own computer (Python 3.8+, nothing to install).

Does the same job as worker.js: asks adsb.fi (adsb.lol as backup) for the aircraft near a point and passes the answer
on with permission for web pages. It also serves the radar page itself, so the simplest setup is:

    python api/proxy.py            then open  http://localhost:8787

and in the page's Settings choose "Live: my own API" with the address http://localhost:8787

Options:  --port 8787   --host 127.0.0.1 (use 0.0.0.0 to let other devices on your network open it)
          --origins "https://your-name.github.io"   (who may call the API from another site; default: any)
"""
import argparse, json, os, time, urllib.error, urllib.parse, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # the repository folder (index.html)
SOURCES = ["https://opendata.adsb.fi/api/v3/lat/{la}/lon/{lo}/dist/{d}", "https://api.adsb.lol/v2/point/{la}/{lo}/{d}"]
CACHE = {}


def aircraft(la, lo, d):
    key = (la, lo, d)
    hit = CACHE.get(key)
    if hit and time.time() - hit[0] < 2:
        return hit[1]
    last = "no source answered"
    for src in SOURCES:
        url = src.format(la=la, lo=lo, d=d)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "air-traffic-radar (personal use)"})
            with urllib.request.urlopen(req, timeout=10) as r:
                j = json.load(r)
            body = json.dumps({"source": urllib.parse.urlparse(url).hostname, "now": time.time(), "ac": j.get("ac") or j.get("aircraft") or []})
            CACHE[key] = (time.time(), body)
            return body
        except Exception as e:                                        # try the next source
            last = f"{urllib.parse.urlparse(url).hostname}: {e}"
    raise RuntimeError(last)


class Handler(SimpleHTTPRequestHandler):
    origins = ["*"]

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE, **kw)

    def cors(self):
        o = self.headers.get("Origin", "")
        if "*" in self.origins:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif o in self.origins:
            self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Vary", "Origin")

    def answer(self, code, body):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/" and "lat" in q:                              # the API
            try:
                lat, lon = float(q["lat"]), float(q["lon"])
                d = max(1, min(30, round(float(q.get("dist", 4)))))
                if abs(lat) > 90 or abs(lon) > 180:
                    raise ValueError
            except (KeyError, ValueError):
                return self.answer(400, '{"error": "lat and lon are required"}')
            try:
                return self.answer(200, aircraft(f"{lat:.2f}", f"{lon:.2f}", d))
            except RuntimeError as e:
                return self.answer(502, json.dumps({"error": str(e)}))
        return super().do_GET()                                       # the radar page and its files

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--origins", default="*")
    a = ap.parse_args()
    Handler.origins = [o.strip().rstrip("/") for o in a.origins.split(",") if o.strip()]
    print(f"Air Traffic Radar on http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}  (Ctrl+C to stop)")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
