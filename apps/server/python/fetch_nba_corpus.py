# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "beautifulsoup4>=4.12.3",
# ]
# ///

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from typing import Iterable

from bs4 import BeautifulSoup


ROOT_DIR = Path(__file__).resolve().parents[3]
TARGET_DIR = ROOT_DIR / "knowledge" / "nba"

SOURCES = [
    {
        "title": "NBA Rulebook Definitions",
        "url": "https://official.nba.com/rule-no-4-definitions/",
        "category": "rules",
        "slug": "official-rule-definitions",
    },
    {
        "title": "NBA Violations and Penalties",
        "url": "https://official.nba.com/rule-no-10-violations-and-penalties/",
        "category": "rules",
        "slug": "official-violations-penalties",
    },
    {
        "title": "NBA Fouls and Penalties",
        "url": "https://official.nba.com/rule-no-12-fouls-and-penalties/",
        "category": "rules",
        "slug": "official-fouls-penalties",
    },
    {
        "title": "NBA Instant Replay",
        "url": "https://official.nba.com/rule-no-13-instant-replay/",
        "category": "rules",
        "slug": "official-instant-replay",
    },
    {
        "title": "NBA Stats Glossary Official",
        "url": "https://www.nba.com/stats/help/glossary",
        "category": "glossary",
        "slug": "official-stats-glossary",
    },
    {
        "title": "NBA History All-Time Awards",
        "url": "https://www.nba.com/news/history-all-time-awards",
        "category": "history",
        "slug": "official-history-awards",
    },
    {
        "title": "NBA History All-Time Records",
        "url": "https://www.nba.com/news/history-all-time-records",
        "category": "history",
        "slug": "official-history-records",
    },
    {
        "title": "NBA MVP Award Winners",
        "url": "https://www.nba.com/news/history-mvp-award-winners",
        "category": "history",
        "slug": "official-history-mvp-awards",
    },
]


def fetch_html(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36"
        },
    )
    with urllib.request.urlopen(request) as response:
        return response.read().decode("utf-8", errors="ignore")


def candidate_roots(soup: BeautifulSoup) -> Iterable:
    selectors = [
        "article",
        "main",
        "[role='main']",
        ".Article_article__2Ue3h",
        ".Article_article__content",
        ".ArticleBody",
        ".article__body",
        ".entry-content",
    ]
    for selector in selectors:
        for node in soup.select(selector):
            yield node
    yield soup.body or soup


def clean_line(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace(" .", ".")
    return text


def extract_lines(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "noscript", "svg", "img", "button"]):
        tag.decompose()

    best_lines: list[str] = []
    for root in candidate_roots(soup):
        lines: list[str] = []
        seen = set()
        for element in root.find_all(["h1", "h2", "h3", "p", "li"]):
            text = clean_line(element.get_text(" ", strip=True))
            if len(text) < 20:
                continue
            if text in seen:
                continue
            seen.add(text)
            prefix = ""
            if element.name == "h1":
                prefix = "# "
            elif element.name == "h2":
                prefix = "## "
            elif element.name == "h3":
                prefix = "### "
            elif element.name == "li":
                prefix = "- "
            lines.append(prefix + text)
        if len(lines) > len(best_lines):
            best_lines = lines
    return best_lines


def write_markdown(source: dict[str, str], lines: list[str]) -> Path:
    category_dir = TARGET_DIR / source["category"]
    category_dir.mkdir(parents=True, exist_ok=True)
    target_path = category_dir / f"{source['slug']}.md"
    body = "\n\n".join(lines)
    text = "\n".join(
        [
            "---",
            f"title: {source['title']}",
            f"source: {source['url']}",
            f"category: {source['category']}",
            "---",
            "",
            body.strip(),
            "",
        ]
    )
    target_path.write_text(text, encoding="utf-8")
    return target_path


def main() -> None:
    written_files: list[str] = []
    for source in SOURCES:
        html = fetch_html(source["url"])
        lines = extract_lines(html)
        if not lines:
            continue
        target = write_markdown(source, lines)
        written_files.append(str(target.relative_to(ROOT_DIR)))

    print(json.dumps({"ok": True, "written_files": written_files}, ensure_ascii=False))


if __name__ == "__main__":
    main()
