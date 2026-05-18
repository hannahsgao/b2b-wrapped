#!/usr/bin/env python3
"""
Scrape public Laurel Timing results for 2026 Bay to Breakers.

Scope:
- Public official result tables: 12K and 15K Breakers Bonus
- Public centipede/team result pages
- Optional public participant detail pages and public split/XHR network capture

This script does not attempt login, bypass controls, brute force bibs, or use private APIs.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

import pandas as pd
from bs4 import BeautifulSoup
from playwright.sync_api import Browser, BrowserContext, Page, Response, sync_playwright


DEFAULT_RACE_URL = "https://results.laurelt.com/bbk/results?race=167945"
DEFAULT_TEAM_URL = "https://results.laurelt.com/bbk/results/teams"
RESULTS_ROOT = "https://results.laurelt.com/bbk/results"
RACE_ID = "167945"
EVENTS = ["12K", "15K Breakers Bonus"]
EVENT_DISTANCE_MILES = {
    "12K": 7.45,
    "15K Breakers Bonus": 9.32,
}
RESULT_HEADER_MARKERS = {"bib", "chip_time", "gun_time"}
TIME_RE = re.compile(r"^(?:\d+:)?\d{1,2}:\d{2}$")


@dataclass
class ScrapeConfig:
    out: Path
    race_url: str = DEFAULT_RACE_URL
    team_url: str = DEFAULT_TEAM_URL
    page_size: int = 1000
    max_pages: int = 500
    delay: float = 0.25
    jitter: float = 0.15
    headful: bool = False
    include_details: bool = False
    details_limit: str = "0"
    capture_splits: bool = True
    skip_teams: bool = False
    include_locations: bool = False


def log(message: str) -> None:
    print(message, flush=True)


def polite_sleep(base_delay: float, jitter: float = 0.15) -> None:
    if base_delay <= 0 and jitter <= 0:
        return
    time.sleep(max(0.0, base_delay + random.uniform(0, jitter)))


def slug_col(value: Any) -> str:
    s = str(value).strip().lower()
    s = s.replace("#", "number")
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    aliases = {
        "bib_number": "bib",
        "pace": "pace_min_mile",
        "pace_min_miles": "pace_min_mile",
        "pace_min_mile": "pace_min_mile",
        "chip": "chip_time",
        "gun": "gun_time",
        "place": "place_overall",
        "overall": "place_overall",
    }
    return aliases.get(s, s)


def parse_time_to_seconds(value: Any) -> int | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() in {"nan", "none", "--", "dns", "dnf"}:
        return None
    if not TIME_RE.match(s):
        return None
    parts = [int(p) for p in s.split(":")]
    if len(parts) == 2:
        minutes, seconds = parts
        return minutes * 60 + seconds
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return hours * 3600 + minutes * 60 + seconds
    return None


def seconds_to_time(seconds: int | float | None) -> str | None:
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return None
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def parse_intish(value: Any) -> int | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() in {"nan", "none", "--"}:
        return None
    s = re.sub(r"[^0-9-]", "", s)
    if not s or s == "-":
        return None
    try:
        return int(s)
    except ValueError:
        return None


def get_query_param(url: str, key: str) -> str | None:
    values = parse_qs(urlparse(url).query).get(key)
    return values[0] if values else None


def ordered_unique(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def detect_result_section_ids(html: str) -> list[str]:
    """Find Laurel's per-result-table pagination IDs from rendered HTML.

    The public page often uses form fields like page_12345 and size_12345 for each
    event/result section. These IDs are not stable, so detect them each run.
    """
    size_ids = re.findall(r"(?:name|id)=[\"']size_(\d+)[\"']", html)
    page_ids = re.findall(r"(?:name|id)=[\"']page_(\d+)[\"']", html)
    all_ids = re.findall(r"(?:loc|page|size)_(\d+)", html)
    candidates = ordered_unique(size_ids + page_ids + all_ids)
    return candidates


def build_results_url(
    loc_12k: str,
    loc_15k: str,
    *,
    page_12k: int,
    page_15k: int,
    page_size: int,
    loc_12k_value: str = "",
    loc_15k_value: str = "",
) -> str:
    params = [
        ("date", ""),
        ("division", ""),
        ("event", ""),
        ("gender", ""),
        (f"loc_{loc_12k}", loc_12k_value),
        (f"loc_{loc_15k}", loc_15k_value),
        (f"page_{loc_12k}", str(page_12k)),
        (f"page_{loc_15k}", str(page_15k)),
        ("race", RACE_ID),
        ("search", ""),
        (f"size_{loc_12k}", str(page_size)),
        (f"size_{loc_15k}", str(page_size)),
        ("sort", ""),
    ]
    return RESULTS_ROOT + "?" + urlencode(params)


def detect_location_options(html: str, section_ids: list[str], base_url: str) -> dict[str, list[dict[str, str]]]:
    """Detect public checkpoint/location options for each event section.

    Laurel pages expose checkpoints either as select options named loc_<section_id>
    or as links whose query string sets loc_<section_id>. This function collects
    value/label pairs without guessing checkpoint IDs.
    """
    soup = BeautifulSoup(html, "lxml")
    options: dict[str, list[dict[str, str]]] = {sid: [] for sid in section_ids[:2]}

    def add(section_id: str, value: str, label: str) -> None:
        label = clean_text(label)
        value = clean_text(value)
        if not label:
            return
        bucket = options.setdefault(section_id, [])
        if not any(x["value"] == value and x["label"] == label for x in bucket):
            bucket.append({"value": value, "label": label})

    for section_id in section_ids[:2]:
        name = f"loc_{section_id}"
        for select in soup.find_all("select", attrs={"name": name}):
            for opt in select.find_all("option"):
                add(section_id, opt.get("value", ""), opt.get_text(" "))
        for inp in soup.find_all(["input", "button"], attrs={"name": name}):
            add(section_id, inp.get("value", ""), inp.get("aria-label") or inp.get("title") or inp.get("value", ""))

    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        qs = parse_qs(urlparse(href).query)
        label = clean_text(a.get_text(" "))
        for section_id in section_ids[:2]:
            key = f"loc_{section_id}"
            if key in qs:
                add(section_id, qs[key][0], label)

    # Remove generic/non-checkpoint choices; keep Finish if it has a real value.
    for section_id, items in list(options.items()):
        cleaned = []
        for item in items:
            label_lower = item["label"].lower()
            if label_lower in {"", "show all", "location", "clear filters", "filter results"}:
                continue
            if item not in cleaned:
                cleaned.append(item)
        options[section_id] = cleaned
    return options


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def table_headers(table: Any) -> list[str]:
    header_cells = table.find_all("th")
    if not header_cells:
        first_row = table.find("tr")
        if first_row:
            header_cells = first_row.find_all(["th", "td"])
    return [slug_col(clean_text(cell.get_text(" "))) for cell in header_cells]


def extract_result_pk_from_href(href: str | None) -> str | None:
    if not href:
        return None
    qs = parse_qs(urlparse(href).query)
    pk = qs.get("pk")
    return pk[0] if pk else None


def extract_result_tables(html: str, base_url: str) -> list[pd.DataFrame]:
    """Extract all visible public leaderboard result tables from a rendered page."""
    soup = BeautifulSoup(html, "lxml")
    result_frames: list[pd.DataFrame] = []

    for table in soup.find_all("table"):
        headers = table_headers(table)
        if not RESULT_HEADER_MARKERS.issubset(set(headers)):
            continue

        rows: list[dict[str, Any]] = []
        for tr in table.find_all("tr"):
            cells = tr.find_all("td")
            if not cells:
                continue
            if len(cells) < len(headers):
                continue

            values = [clean_text(cell.get_text(" ")) for cell in cells[: len(headers)]]
            row = dict(zip(headers, values))

            href = None
            for a in tr.find_all("a", href=True):
                if "/bbk/results" in a["href"] and "pk=" in a["href"]:
                    href = urljoin(base_url, a["href"])
                    break
            if href:
                row["participant_url"] = href
                row["result_pk"] = extract_result_pk_from_href(href)
            rows.append(row)

        if rows:
            result_frames.append(pd.DataFrame(rows))

    # Fallback: pandas can sometimes see tables even when manual parsing misses links.
    if not result_frames:
        try:
            for df in pd.read_html(html):
                df.columns = [slug_col(c) for c in df.columns]
                if RESULT_HEADER_MARKERS.issubset(set(df.columns)):
                    result_frames.append(df)
        except ValueError:
            pass

    return result_frames


def normalize_result_frame(df: pd.DataFrame, event: str, source_url: str) -> pd.DataFrame:
    df = df.copy()
    df.columns = [slug_col(c) for c in df.columns]

    # Common Laurel labels.
    rename = {
        "place_overall": "place_overall",
        "place_gender": "place_gender",
        "place_div": "place_div",
        "bib": "bib",
        "last_name": "last_name",
        "first_name": "first_name",
        "gender": "gender",
        "age": "age",
        "chip_time": "chip_time",
        "pace_min_mile": "pace_min_mile",
        "gun_time": "gun_time",
        "participant_url": "participant_url",
        "result_pk": "result_pk",
    }
    df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})

    for col in ["place_overall", "bib", "age"]:
        if col in df.columns:
            df[col] = df[col].map(parse_intish)

    # Place Gender is displayed like "1 M". Keep raw and split if possible.
    if "place_gender" in df.columns:
        df["place_gender_raw"] = df["place_gender"].astype(str).map(clean_text)
        df["place_gender_rank"] = df["place_gender_raw"].map(lambda s: parse_intish(s.split(" ")[0] if s else None))

    if "chip_time" in df.columns:
        df["chip_seconds"] = df["chip_time"].map(parse_time_to_seconds)
    if "gun_time" in df.columns:
        df["gun_seconds"] = df["gun_time"].map(parse_time_to_seconds)
    if "pace_min_mile" in df.columns:
        df["pace_seconds_per_mile"] = df["pace_min_mile"].map(parse_time_to_seconds)

    for col in ["first_name", "last_name", "gender", "place_div", "participant_url", "result_pk"]:
        if col not in df.columns:
            df[col] = None

    df.insert(0, "event", event)
    df.insert(1, "event_date", "2026-05-17")
    df["distance_miles"] = EVENT_DISTANCE_MILES.get(event)
    df["source_url"] = source_url

    df["display_name"] = (
        df.get("first_name", pd.Series([""] * len(df))).fillna("").astype(str).str.strip()
        + " "
        + df.get("last_name", pd.Series([""] * len(df))).fillna("").astype(str).str.strip()
    ).str.strip()

    # Remove rows that are obviously not result rows.
    if "bib" in df.columns:
        df = df[df["bib"].notna()].copy()
    if "chip_seconds" in df.columns:
        df = df[df["chip_seconds"].notna()].copy()

    preferred_cols = [
        "event",
        "event_date",
        "place_overall",
        "place_gender",
        "place_gender_raw",
        "place_gender_rank",
        "place_div",
        "bib",
        "last_name",
        "first_name",
        "display_name",
        "gender",
        "age",
        "chip_time",
        "chip_seconds",
        "pace_min_mile",
        "pace_seconds_per_mile",
        "gun_time",
        "gun_seconds",
        "distance_miles",
        "participant_url",
        "result_pk",
        "source_url",
    ]
    for col in preferred_cols:
        if col not in df.columns:
            df[col] = None
    return df[preferred_cols]


def first_rows_fingerprint(df: pd.DataFrame) -> str:
    cols = [c for c in ["event", "bib", "chip_time", "display_name"] if c in df.columns]
    text = df[cols].head(20).to_json(orient="records", force_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def scrape_leaderboards(page: Page, cfg: ScrapeConfig) -> pd.DataFrame:
    log(f"Loading race page: {cfg.race_url}")
    page.goto(cfg.race_url, wait_until="networkidle", timeout=90_000)
    html = page.content()
    section_ids = detect_result_section_ids(html)
    log(f"Detected result section IDs: {section_ids[:6]}")

    frames: list[pd.DataFrame] = []

    if len(section_ids) >= 2:
        loc_12k, loc_15k = section_ids[:2]
        for event_index, event in enumerate(EVENTS):
            seen_fingerprints: set[str] = set()
            log(f"\nScraping {event} leaderboard")
            for page_num in range(1, cfg.max_pages + 1):
                url = build_results_url(
                    loc_12k,
                    loc_15k,
                    page_12k=page_num if event_index == 0 else 1,
                    page_15k=page_num if event_index == 1 else 1,
                    page_size=cfg.page_size,
                )
                page.goto(url, wait_until="networkidle", timeout=90_000)
                html = page.content()
                tables = extract_result_tables(html, url)
                if event_index >= len(tables):
                    if page_num == 1:
                        raise RuntimeError(f"Could not find table index {event_index} for {event} at {url}")
                    log(f"No table for {event} page {page_num}; stopping")
                    break

                df = normalize_result_frame(tables[event_index], event=event, source_url=url)
                fp = first_rows_fingerprint(df)
                if page_num > 1 and fp in seen_fingerprints:
                    log(f"Repeated first rows on {event} page {page_num}; stopping")
                    break
                seen_fingerprints.add(fp)

                if df.empty:
                    log(f"{event} page {page_num}: 0 rows; stopping")
                    break

                frames.append(df)
                log(f"{event} page {page_num}: {len(df)} rows")
                if len(df) < cfg.page_size:
                    break
                polite_sleep(cfg.delay, cfg.jitter)
    else:
        log("Could not detect Laurel section IDs. Falling back to first rendered page only.")
        tables = extract_result_tables(html, cfg.race_url)
        for i, event in enumerate(EVENTS[: len(tables)]):
            frames.append(normalize_result_frame(tables[i], event=event, source_url=cfg.race_url))

    if not frames:
        raise RuntimeError("No leaderboard rows found")

    results = pd.concat(frames, ignore_index=True)
    dedupe_cols = [c for c in ["event", "bib", "result_pk", "chip_seconds"] if c in results.columns]
    if dedupe_cols:
        results = results.drop_duplicates(subset=dedupe_cols, keep="first")
    results = results.sort_values(["event", "chip_seconds", "gun_seconds", "bib"], na_position="last").reset_index(drop=True)
    return results


def scrape_location_leaderboards(page: Page, cfg: ScrapeConfig, section_ids: list[str]) -> pd.DataFrame:
    """Scrape public checkpoint/location leaderboard tables when exposed.

    This is optional because it can add hundreds of page loads. The main finish
    leaderboard already covers the core Wrapped site. Location tables are useful
    for split/checkpoint cards if Laurel exposes them through the same public UI.
    """
    if len(section_ids) < 2:
        log("Skipping location scrape: result section IDs unavailable")
        return pd.DataFrame()

    page.goto(cfg.race_url, wait_until="networkidle", timeout=90_000)
    options_by_section = detect_location_options(page.content(), section_ids, cfg.race_url)
    loc_12k, loc_15k = section_ids[:2]
    section_for_event = {"12K": loc_12k, "15K Breakers Bonus": loc_15k}

    frames: list[pd.DataFrame] = []
    for event_index, event in enumerate(EVENTS):
        section_id = section_for_event[event]
        options = options_by_section.get(section_id, [])
        # Blank/default location is already scraped as the finish leaderboard.
        options = [opt for opt in options if opt.get("value")]
        if not options:
            log(f"No checkpoint options detected for {event}")
            continue

        log(f"\nScraping {len(options)} public checkpoint/location tables for {event}")
        for opt in options:
            label = opt["label"]
            value = opt["value"]
            seen_fingerprints: set[str] = set()
            for page_num in range(1, cfg.max_pages + 1):
                url = build_results_url(
                    loc_12k,
                    loc_15k,
                    page_12k=page_num if event_index == 0 else 1,
                    page_15k=page_num if event_index == 1 else 1,
                    page_size=cfg.page_size,
                    loc_12k_value=value if event_index == 0 else "",
                    loc_15k_value=value if event_index == 1 else "",
                )
                page.goto(url, wait_until="networkidle", timeout=90_000)
                tables = extract_result_tables(page.content(), url)
                if event_index >= len(tables):
                    if page_num == 1:
                        log(f"  {event} {label}: no result-shaped table; skipping")
                    break
                df = normalize_result_frame(tables[event_index], event=event, source_url=url)
                if df.empty:
                    break
                fp = first_rows_fingerprint(df)
                if page_num > 1 and fp in seen_fingerprints:
                    break
                seen_fingerprints.add(fp)
                df.insert(2, "location_label", label)
                df.insert(3, "location_value", value)
                frames.append(df)
                log(f"  {event} {label} page {page_num}: {len(df)} rows")
                if len(df) < cfg.page_size:
                    break
                polite_sleep(cfg.delay, cfg.jitter)

    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    dedupe_cols = [c for c in ["event", "location_value", "bib", "result_pk", "chip_seconds"] if c in out.columns]
    if dedupe_cols:
        out = out.drop_duplicates(subset=dedupe_cols, keep="first")
    out_path = cfg.out / "b2b_2026_location_results_raw.csv"
    out.to_csv(out_path, index=False)
    log(f"Saved {out_path}")
    return out


def write_results_outputs(results: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir / "b2b_2026_results_raw.csv"
    links_path = out_dir / "b2b_2026_result_links.csv"
    results.to_csv(raw_path, index=False, quoting=csv.QUOTE_MINIMAL)

    links_cols = ["event", "bib", "display_name", "participant_url", "result_pk"]
    links = results[[c for c in links_cols if c in results.columns]].dropna(subset=["participant_url"]).drop_duplicates()
    links.to_csv(links_path, index=False)

    log(f"\nSaved {raw_path}")
    log(f"Saved {links_path}")
    log("Rows by event:")
    log(str(results.groupby("event").size()))


def extract_team_links(html: str, base_url: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n")
    teams: list[dict[str, Any]] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/bbk/results/teams" not in href or "team_pk=" not in href:
            continue
        url = urljoin(base_url, href)
        team_pk = get_query_param(url, "team_pk")
        if not team_pk or team_pk in seen:
            continue
        seen.add(team_pk)
        name = clean_text(a.get_text(" "))
        rank = None
        avg = None
        # Look for a visible summary line containing rank, team name, and average time.
        pattern = re.compile(rf"(?m)^\s*(\d+)\.\s+{re.escape(name)}\s+({TIME_RE.pattern[1:-1]})\b")
        m = pattern.search(text)
        if m:
            rank = parse_intish(m.group(1))
            avg = m.group(2)
        teams.append({"team_pk": team_pk, "team_name": name, "team_url": url, "team_rank": rank, "team_avg_chip_time": avg})
    return teams


def parse_team_detail(html: str, base_url: str, team: dict[str, Any]) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    lines = [clean_text(x) for x in soup.get_text("\n").splitlines()]
    lines = [x for x in lines if x]

    link_by_name: dict[str, str] = {}
    pk_by_name: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/bbk/results" in href and "pk=" in href:
            name = clean_text(a.get_text(" "))
            url = urljoin(base_url, href)
            link_by_name[name] = url
            pk = extract_result_pk_from_href(url)
            if pk:
                pk_by_name[name] = pk

    rows: list[dict[str, Any]] = []
    member_re = re.compile(r"^(\d+)\.\s+(.+?)\s+(12K|15K(?:\s+Breakers\s+Bonus)?)\s+((?:\d+:)?\d{1,2}:\d{2})$")
    for line in lines:
        m = member_re.match(line)
        if not m:
            continue
        order, name, event, chip = m.groups()
        name = clean_text(name)
        event = "15K Breakers Bonus" if event.startswith("15K") else "12K"
        rows.append(
            {
                **team,
                "member_order": parse_intish(order),
                "member_name": name,
                "member_event": event,
                "member_chip_time": chip,
                "member_chip_seconds": parse_time_to_seconds(chip),
                "member_participant_url": link_by_name.get(name),
                "member_result_pk": pk_by_name.get(name),
            }
        )
    return rows


def scrape_teams(page: Page, cfg: ScrapeConfig) -> pd.DataFrame:
    log(f"\nLoading team page: {cfg.team_url}")
    page.goto(cfg.team_url, wait_until="networkidle", timeout=90_000)
    html = page.content()
    teams = extract_team_links(html, cfg.team_url)
    log(f"Found {len(teams)} public team links")

    rows: list[dict[str, Any]] = []
    for i, team in enumerate(teams, start=1):
        page.goto(team["team_url"], wait_until="networkidle", timeout=90_000)
        detail_rows = parse_team_detail(page.content(), cfg.team_url, team)
        if not detail_rows:
            rows.append({**team, "member_order": None, "member_name": None, "member_event": None, "member_chip_time": None})
        else:
            rows.extend(detail_rows)
        if i % 10 == 0 or i == len(teams):
            log(f"Team pages: {i}/{len(teams)}")
        polite_sleep(cfg.delay, cfg.jitter)

    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    out_path = cfg.out / "b2b_2026_teams_raw.csv"
    df.to_csv(out_path, index=False)
    log(f"Saved {out_path}")
    return df


def safe_filename(value: str, max_len: int = 150) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return value[:max_len] or "file"


def response_payload(response: Response) -> tuple[str, str] | None:
    url = response.url
    lower = url.lower()
    try:
        headers = {k.lower(): v for k, v in response.headers.items()}
    except Exception:
        headers = {}
    content_type = headers.get("content-type", "").lower()
    interesting = (
        "application/json" in content_type
        or "text/json" in content_type
        or response.request.resource_type in {"xhr", "fetch"}
        or "time/articles" in lower
        or "splits" in lower
    )
    if not interesting:
        return None
    try:
        text = response.text()
    except Exception:
        return None
    if not text:
        return None
    ext = ".json" if "json" in content_type or text.lstrip().startswith(("{", "[")) else ".txt"
    return text, ext


def parse_detail_page(html: str, detail_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")
    lines = [clean_text(x) for x in soup.get_text("\n").splitlines()]
    lines = [x for x in lines if x]

    title = None
    bib = None
    for tag in soup.find_all(re.compile(r"^h[1-6]$")):
        txt = clean_text(tag.get_text(" "))
        m = re.match(r"^(.+?)\s+#(\d+)$", txt)
        if m:
            title = m.group(1)
            bib = parse_intish(m.group(2))
            break

    def prev_value(label: str, offset: int = 1) -> str | None:
        for i, line in enumerate(lines):
            if line.lower() == label.lower() and i >= offset:
                return lines[i - offset]
        return None

    event = None
    for candidate in EVENTS:
        if candidate in lines:
            event = candidate
            break
    if not event and "15K" in lines:
        event = "15K Breakers Bonus"
    if not event and "12K" in lines:
        event = "12K"

    result_card_url = None
    split_url = None
    photo_urls: list[str] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(detail_url, a["href"])
        text = clean_text(a.get_text(" ")).lower()
        if "time/articles" in href or "laurel splits" in text:
            split_url = href
        if "result_cards" in href and not result_card_url:
            result_card_url = href
        elif "brookseeevents.s3" in href and href not in photo_urls:
            # Save URL only; do not download/mirror photos by default.
            photo_urls.append(href)
    for img in soup.find_all("img", src=True):
        src = urljoin(detail_url, img["src"])
        if "result_cards" in src and not result_card_url:
            result_card_url = src

    rankings: dict[str, dict[str, int | None]] = {}
    for i, line in enumerate(lines):
        label = line.strip()
        if label in {"Overall", "Male", "Female", "Nonbinary", "NB"} or re.match(r"^[MFN][A-Za-z0-9 &-]+$", label):
            if i >= 2:
                rank = parse_intish(lines[i - 2])
                total = parse_intish(lines[i - 1])
                if rank is not None and total is not None:
                    rankings[label] = {"rank": rank, "total": total}

    detail = {
        "detail_url": detail_url,
        "result_pk": extract_result_pk_from_href(detail_url),
        "name": title,
        "bib": bib,
        "event": event,
        "chip_time": prev_value("Chip Time"),
        "chip_seconds": parse_time_to_seconds(prev_value("Chip Time")),
        "pace_min_mile": prev_value("Pace (min/miles)") or prev_value("Pace"),
        "distance_miles": None,
        "rankings": rankings,
        "split_url": split_url,
        "result_card_url": result_card_url,
        "photo_urls": photo_urls,
    }
    dist = prev_value("Distance")
    if dist:
        try:
            detail["distance_miles"] = float(dist)
        except ValueError:
            pass
    return detail


def capture_split_network(context: BrowserContext, split_url: str, result_pk: str | None, out_dir: Path, delay: float, jitter: float) -> list[dict[str, str]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    page = context.new_page()
    captured: list[dict[str, str]] = []

    def handle_response(response: Response) -> None:
        payload = response_payload(response)
        if not payload:
            return
        text, ext = payload
        digest = hashlib.sha1(response.url.encode("utf-8")).hexdigest()[:10]
        prefix = result_pk or "unknown"
        filename = safe_filename(f"{prefix}_{digest}{ext}")
        path = out_dir / filename
        try:
            path.write_text(text, encoding="utf-8")
            captured.append({"url": response.url, "path": str(path), "content_type": response.headers.get("content-type", "")})
        except Exception:
            return

    page.on("response", handle_response)
    try:
        page.goto(split_url, wait_until="networkidle", timeout=60_000)
        page.wait_for_timeout(2500)
        html_path = out_dir / safe_filename(f"{result_pk or 'unknown'}_rendered_split.html")
        html_path.write_text(page.content(), encoding="utf-8")
        captured.append({"url": split_url, "path": str(html_path), "content_type": "text/html rendered"})
    except Exception as exc:
        captured.append({"url": split_url, "path": "", "content_type": f"error: {exc}"})
    finally:
        page.close()
        polite_sleep(delay, jitter)
    return captured


def details_limit_to_int(value: str, total: int) -> int:
    if str(value).lower() == "all":
        return total
    try:
        return max(0, int(value))
    except ValueError:
        return 0


def scrape_details(context: BrowserContext, cfg: ScrapeConfig, links: pd.DataFrame) -> None:
    if links.empty:
        log("No participant links to scrape")
        return
    limit = details_limit_to_int(cfg.details_limit, len(links))
    if limit <= 0:
        log("Detail scraping requested but details-limit is 0")
        return
    links = links.dropna(subset=["participant_url"]).drop_duplicates(subset=["participant_url"]).head(limit)

    detail_path = cfg.out / "b2b_2026_participant_details.jsonl"
    network_dir = cfg.out / "detail_network"
    log(f"\nScraping {len(links)} public participant detail pages")
    with detail_path.open("w", encoding="utf-8") as f:
        page = context.new_page()
        for i, row in enumerate(links.itertuples(index=False), start=1):
            url = getattr(row, "participant_url")
            result_pk = getattr(row, "result_pk", None)
            try:
                page.goto(url, wait_until="networkidle", timeout=60_000)
                detail = parse_detail_page(page.content(), url)
                detail["leaderboard_event"] = getattr(row, "event", None)
                detail["leaderboard_bib"] = getattr(row, "bib", None)
                detail["leaderboard_display_name"] = getattr(row, "display_name", None)
                detail["network_captures"] = []
                if cfg.capture_splits and detail.get("split_url"):
                    detail["network_captures"] = capture_split_network(
                        context,
                        detail["split_url"],
                        result_pk or detail.get("result_pk"),
                        network_dir,
                        cfg.delay,
                        cfg.jitter,
                    )
                f.write(json.dumps(detail, ensure_ascii=False) + "\n")
            except Exception as exc:
                f.write(json.dumps({"detail_url": url, "result_pk": result_pk, "error": str(exc)}, ensure_ascii=False) + "\n")
            if i % 25 == 0 or i == len(links):
                log(f"Detail pages: {i}/{len(links)}")
            polite_sleep(cfg.delay, cfg.jitter)
        page.close()
    log(f"Saved {detail_path}")


def parse_args(argv: list[str]) -> ScrapeConfig:
    parser = argparse.ArgumentParser(description="Scrape public Bay to Breakers 2026 Laurel results")
    parser.add_argument("--out", default="data", type=Path, help="Output directory")
    parser.add_argument("--race-url", default=DEFAULT_RACE_URL)
    parser.add_argument("--team-url", default=DEFAULT_TEAM_URL)
    parser.add_argument("--page-size", default=1000, type=int)
    parser.add_argument("--max-pages", default=500, type=int)
    parser.add_argument("--delay", default=0.25, type=float, help="Base delay between page requests")
    parser.add_argument("--jitter", default=0.15, type=float, help="Random extra delay")
    parser.add_argument("--headful", action="store_true", help="Show browser")
    parser.add_argument("--include-details", action="store_true", help="Scrape public participant detail pages")
    parser.add_argument("--details-limit", default="0", help="Number of detail pages, or 'all'")
    parser.add_argument("--no-capture-splits", action="store_true", help="Do not visit/capture public split URLs from detail pages")
    parser.add_argument("--skip-teams", action="store_true", help="Do not scrape public team pages")
    parser.add_argument("--include-locations", action="store_true", help="Also scrape public checkpoint/location leaderboard tables when exposed")
    ns = parser.parse_args(argv)
    return ScrapeConfig(
        out=ns.out,
        race_url=ns.race_url,
        team_url=ns.team_url,
        page_size=ns.page_size,
        max_pages=ns.max_pages,
        delay=ns.delay,
        jitter=ns.jitter,
        headful=ns.headful,
        include_details=ns.include_details,
        details_limit=ns.details_limit,
        capture_splits=not ns.no_capture_splits,
        skip_teams=ns.skip_teams,
        include_locations=ns.include_locations,
    )


def main(argv: list[str] | None = None) -> int:
    cfg = parse_args(argv or sys.argv[1:])
    cfg.out.mkdir(parents=True, exist_ok=True)
    log(json.dumps({**asdict(cfg), "out": str(cfg.out)}, indent=2))

    with sync_playwright() as pw:
        browser: Browser = pw.chromium.launch(headless=not cfg.headful)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            viewport={"width": 1440, "height": 1200},
        )
        page = context.new_page()
        results = scrape_leaderboards(page, cfg)
        write_results_outputs(results, cfg.out)

        if cfg.include_locations:
            page.goto(cfg.race_url, wait_until="networkidle", timeout=90_000)
            scrape_location_leaderboards(page, cfg, detect_result_section_ids(page.content()))

        if not cfg.skip_teams:
            scrape_teams(page, cfg)

        if cfg.include_details:
            links_path = cfg.out / "b2b_2026_result_links.csv"
            links = pd.read_csv(links_path) if links_path.exists() else pd.DataFrame()
            scrape_details(context, cfg, links)

        browser.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
