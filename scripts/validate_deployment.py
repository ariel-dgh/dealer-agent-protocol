#!/usr/bin/env python3
"""Validate canonical publication URLs, generated site, and registry metadata."""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
CANONICAL = "https://dealeragentprotocol.com"
GATEWAY = "https://dealeragentgateway.com"
REMOTE = "https://mcp.dealeragentgateway.com/dealers/howard-bentley/mcp"


class LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self.links.append(href)


def validate_internal_links(site_root: Path) -> list[str]:
    failures: list[str] = []
    for page in site_root.rglob("*.html"):
        parser = LinkCollector()
        parser.feed(page.read_text(encoding="utf-8"))
        for href in parser.links:
            parsed = urlparse(href)
            if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
                continue
            relative = parsed.path.lstrip("/")
            target = site_root / relative
            if parsed.path.endswith("/"):
                target /= "index.html"
            if not target.exists():
                failures.append(
                    f"{page.relative_to(site_root)}: broken internal link {href}"
                )
    return failures


INDEXNOW_KEY_NAME = re.compile(r"^[a-f0-9]{32}\.txt$")
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
VISIBILITY_HOST = "dealeraivisibility.com"


def visibility_source_for_loc(site_root: Path, loc: str) -> Path | None:
    parsed = urlparse(loc)
    if parsed.scheme != "https" or parsed.netloc != VISIBILITY_HOST or parsed.query or parsed.fragment:
        return None
    if parsed.path == "/":
        return site_root / "index.html"
    relative = parsed.path.lstrip("/")
    if parsed.path.endswith("/"):
        return site_root / relative / "index.html"
    return site_root / relative


def html_is_noindex(path: Path) -> bool:
    if path.suffix != ".html" or not path.is_file():
        return False
    for tag in re.findall(r"<meta\b[^>]*>", path.read_text(encoding="utf-8"), flags=re.I):
        if re.search(r"\brobots\b", tag, flags=re.I) and re.search(r"\bnoindex\b", tag, flags=re.I):
            return True
    return False


def validate_visibility_indexnow() -> list[str]:
    failures: list[str] = []
    source = ROOT / "dealer-ai-visibility-site" / "src"
    dist = ROOT / "dealer-ai-visibility-site" / "dist"
    for label, directory in (("src", source), ("dist", dist)):
        keys = [path for path in directory.glob("*.txt") if INDEXNOW_KEY_NAME.fullmatch(path.name)]
        if len(keys) != 1:
            failures.append(f"dealer-ai-visibility-site/{label}: expected one IndexNow key file, found {len(keys)}")
            continue
        key = keys[0].stem
        body = keys[0].read_text(encoding="utf-8").lstrip("\ufeff").strip()
        if body != key:
            failures.append(f"{keys[0].relative_to(ROOT)}: key file body does not match {key}.txt")
    sitemap_path = dist / "sitemap.xml"
    if source.joinpath("sitemap.xml").is_file() and sitemap_path.is_file():
        if source.joinpath("sitemap.xml").read_bytes() != sitemap_path.read_bytes():
            failures.append("dealer-ai-visibility-site: src and dist sitemaps differ")
    try:
        root = ET.fromstring(sitemap_path.read_text(encoding="utf-8"))
    except (ET.ParseError, OSError) as error:
        failures.append(f"dealer-ai-visibility-site/dist/sitemap.xml: invalid XML ({error})")
        return failures
    if root.tag != "{http://www.sitemaps.org/schemas/sitemap/0.9}urlset":
        failures.append("dealer-ai-visibility-site/dist/sitemap.xml: root is not a sitemap urlset")
        return failures
    urls = root.findall("sm:url", SITEMAP_NS)
    if not urls:
        failures.append("dealer-ai-visibility-site/dist/sitemap.xml: no URLs")
    for url in urls:
        loc = (url.findtext("sm:loc", default="", namespaces=SITEMAP_NS) or "").strip()
        lastmod = (url.findtext("sm:lastmod", default="", namespaces=SITEMAP_NS) or "").strip()
        target = visibility_source_for_loc(dist, loc)
        if target is None or not target.is_file():
            failures.append(f"dealer-ai-visibility-site/dist/sitemap.xml: {loc or '(missing loc)'} does not exist in the site")
        elif html_is_noindex(target):
            failures.append(f"dealer-ai-visibility-site/dist/sitemap.xml: {loc} is noindex")
        try:
            date.fromisoformat(lastmod)
        except ValueError:
            failures.append(f"dealer-ai-visibility-site/dist/sitemap.xml: {loc} has invalid lastmod {lastmod!r}")
    for name in ("dealer-ai-visibility.wrangler.jsonc", "dealer-ai-visibility.staging.wrangler.jsonc"):
        config = (ROOT / "deployment" / "cloudflare" / name).read_text(encoding="utf-8")
        if "single-page-application" in config:
            failures.append(f"{name}: IndexNow key must not use SPA not-found handling")
        if '"not_found_handling": "404-page"' not in config:
            failures.append(f"{name}: expected not_found_handling 404-page")
        if "dealer-ai-visibility-site/dist" not in config:
            failures.append(f"{name}: assets directory is not the visibility dist")
    worker = (ROOT / "deployment" / "cloudflare" / "dealer-ai-visibility-worker.mjs").read_text(encoding="utf-8")
    if "text/plain; charset=utf-8" not in worker or "([a-f0-9]{32})" not in worker:
        failures.append("dealer-ai-visibility-worker.mjs: IndexNow key is not served as text/plain")
    return failures


def main() -> int:
    failures: list[str] = []

    schema_paths = sorted((ROOT / "spec" / "v0.1" / "schemas").glob("*.schema.json"))
    schema_paths.append(ROOT / "conformance" / "claim.schema.json")
    for path in schema_paths:
        schema = json.loads(path.read_text(encoding="utf-8"))
        if not schema.get("$id", "").startswith(f"{CANONICAL}/"):
            failures.append(f"{path.relative_to(ROOT)}: noncanonical $id")

    server_path = ROOT / "registry" / "server.json"
    server = json.loads(server_path.read_text(encoding="utf-8"))
    if server.get("name") != "com.dealeragentgateway/howard-bentley":
        failures.append("registry/server.json: unexpected registry name")
    if len(server.get("description", "")) > 100:
        failures.append("registry/server.json: description exceeds registry limit")
    remotes = server.get("remotes", [])
    if remotes != [{"type": "streamable-http", "url": REMOTE}]:
        failures.append("registry/server.json: remote endpoint differs from canonical deployment")
    if server.get("websiteUrl") != f"{GATEWAY}/":
        failures.append("registry/server.json: websiteUrl is not the canonical Gateway site")

    required_site_files = [
        "index.html",
        "styles.css",
        "favicon.svg",
        "how-it-works/index.html",
        "why/index.html",
        "used-vehicles/index.html",
        "inventory-sources/index.html",
        "compare/index.html",
        "adopt/index.html",
        "pilot/index.html",
        "pilot/app.js",
        "docs/index.html",
        "docs/core-concepts/index.html",
        "docs/tools/index.html",
        "docs/used-vehicles/index.html",
        "docs/pricing/index.html",
        "docs/security/index.html",
        "docs/conformance/index.html",
        "docs/quickstart/index.html",
        "privacy/index.html",
        "terms/index.html",
        "robots.txt",
        "sitemap.xml",
        "llms.txt",
        "server.json",
        "spec/v0.1/SPEC.md",
        "spec/v0.1/capabilities.yaml",
        "spec/v0.1/used-vehicles.md",
        "spec/v0.1/schemas/index.html",
        "spec/v0.1/schemas/manifest.schema.json",
        "spec/v0.1/schemas/used-vehicle.schema.json",
        "site.webmanifest",
        "LICENSE.txt",
        "NOTICE.txt",
        "CONTRIBUTING.md",
        "og.png",
    ]
    for relative in required_site_files:
        if not (ROOT / "site" / "dist" / relative).is_file():
            failures.append(f"site/dist/{relative}: missing generated publication file")

    source_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in [
            ROOT / "site" / "src" / "index.html",
            ROOT / "site" / "src" / "how-it-works" / "index.html",
            ROOT / "site" / "src" / "adopt" / "index.html",
            ROOT / "site" / "src" / "pilot" / "index.html",
            ROOT / "site" / "src" / "docs" / "index.html",
            ROOT / "site" / "src" / "robots.txt",
            ROOT / "site" / "src" / "sitemap.xml",
            ROOT / "site" / "src" / "llms.txt",
        ]
    )
    if CANONICAL not in source_text or REMOTE not in source_text:
        failures.append("site source: canonical protocol or gateway URL is absent")
    if "dealeragentprotocol.example" in source_text:
        failures.append("site source: placeholder domain remains")
    if "dealership systems protocol" in source_text.lower():
        failures.append("site source: ambiguous dealership-systems positioning remains")
    failures.extend(validate_internal_links(ROOT / "site" / "dist"))

    required_gateway_files = [
        "index.html",
        "styles.css",
        "app.js",
        "robots.txt",
        "sitemap.xml",
        "llms.txt",
        "site.webmanifest",
        "server.json",
        "privacy/index.html",
        "terms/index.html",
        "LICENSE.txt",
        "NOTICE.txt",
        "CONTRIBUTING.md",
        "og.png",
    ]
    for relative in required_gateway_files:
        if not (ROOT / "gateway-site" / "dist" / relative).is_file():
            failures.append(f"gateway-site/dist/{relative}: missing generated publication file")

    required_product_files = [
        "index.html", "styles.css", "app.js", "visibility/index.html", "ai-search/index.html", "gateway/index.html",
        "audit/index.html", "connect/index.html", "how-it-works/index.html", "inventory-sources/index.html", "compare/index.html", "live/index.html", "privacy/index.html",
        "terms/index.html", "robots.txt", "sitemap.xml", "llms.txt", "LICENSE.txt", "NOTICE.txt",
    ]
    for relative in required_product_files:
        if not (ROOT / "dealershipmcp-site" / "dist" / relative).is_file():
            failures.append(f"dealershipmcp-site/dist/{relative}: missing generated publication file")
    failures.extend(validate_internal_links(ROOT / "dealershipmcp-site" / "dist"))

    required_visibility_files = [
        "index.html", "styles.css", "app.js", "analytics.js", "report/index.html", "report.js",
        "methodology/index.html", "privacy/index.html", "terms/index.html", "disclaimer/index.html", "contact/index.html",
        "unsubscribe/index.html", "unsubscribe.js", "robots.txt", "sitemap.xml", "llms.txt",
        "favicon.svg", "site.webmanifest", "404.html", "og.png",
    ]
    for relative in required_visibility_files:
        if not (ROOT / "dealer-ai-visibility-site" / "dist" / relative).is_file():
            failures.append(f"dealer-ai-visibility-site/dist/{relative}: missing generated visibility file")
    failures.extend(validate_internal_links(ROOT / "dealer-ai-visibility-site" / "dist"))
    failures.extend(validate_visibility_indexnow())

    required_aeo_audit_files = [
        "index.html", "styles.css", "app.js", "analytics.js", "methodology/index.html",
        "sample/index.html", "privacy/index.html", "terms/index.html", "disclaimer/index.html",
        "contact/index.html", "robots.txt", "sitemap.xml", "llms.txt", "favicon.svg",
        "site.webmanifest", "404.html", "og.png",
    ]
    for relative in required_aeo_audit_files:
        if not (ROOT / "dealer-aeo-audit-site" / "dist" / relative).is_file():
            failures.append(f"dealer-aeo-audit-site/dist/{relative}: missing generated audit file")
    failures.extend(validate_internal_links(ROOT / "dealer-aeo-audit-site" / "dist"))
    if failures:
        print("Deployment validation failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(
        f"Validated {len(schema_paths)} canonical schema IDs, registry metadata, "
        f"{len(required_site_files)} protocol files, {len(required_product_files)} product files, "
        f"{len(required_visibility_files)} visibility files, {len(required_aeo_audit_files)} AEO audit files, "
        f"and {len(required_gateway_files)} gateway-site files."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
