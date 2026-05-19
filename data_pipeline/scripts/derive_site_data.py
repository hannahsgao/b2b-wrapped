#!/usr/bin/env python3
"""Build lightweight JSON used by the static Bay to Breakers Wrapped site."""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

EVENT_DISTANCE_MILES = {
    "12K": 7.45,
    "15K Breakers Bonus": 9.32,
}
AGE_BUCKETS = [
    (0, 19, "19 & Under"),
    (20, 29, "20-29"),
    (30, 39, "30-39"),
    (40, 49, "40-49"),
    (50, 59, "50-59"),
    (60, 69, "60-69"),
    (70, 79, "70-79"),
    (80, 200, "80+"),
]


def parse_time_to_seconds(value: Any) -> int | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    s = str(value).strip()
    if not s or s.lower() in {"nan", "none", "--"}:
        return None
    if not re.match(r"^(?:\d+:)?\d{1,2}:\d{2}$", s):
        return None
    parts = [int(p) for p in s.split(":")]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def seconds_to_time(seconds: float | int | None) -> str | None:
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return None
    seconds = int(round(float(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def age_group(age: Any) -> str:
    try:
        if age is None or (isinstance(age, float) and math.isnan(age)):
            return "Unknown"
        age_i = int(float(age))
    except Exception:
        return "Unknown"
    for lo, hi, label in AGE_BUCKETS:
        if lo <= age_i <= hi:
            return label
    return "Unknown"


def display_name(row: pd.Series, privacy: str) -> str:
    first = str(row.get("first_name") or "").strip()
    last = str(row.get("last_name") or "").strip()
    full = str(row.get("display_name") or f"{first} {last}").strip()
    if privacy == "full":
        return full or f"Bib {row.get('bib')}"
    if privacy == "none":
        return f"Bib {row.get('bib')}"
    # initials
    if first and last:
        return f"{first} {last[:1]}."
    if full and " " in full:
        parts = full.split()
        return f"{parts[0]} {parts[-1][:1]}."
    return full or f"Bib {row.get('bib')}"


def safe_int(value: Any) -> int | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    try:
        return int(float(value))
    except Exception:
        return None


def safe_float(value: Any) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    try:
        return float(value)
    except Exception:
        return None


_NULLISH_STRINGS = {"", "nan", "none", "---", "n/a"}


def safe_str(value: Any) -> str | None:
    """Return a stripped string, or None for missing / sentinel values.

    Survives pandas reanimating None as float('nan'), and rejects the literal
    strings Laurel emits when a field is blank.
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    s = str(value).strip()
    if not s or s.lower() in _NULLISH_STRINGS:
        return None
    return s


def quantiles(times: list[int]) -> dict[str, Any]:
    if not times:
        return {}
    s = pd.Series(times, dtype="float64")
    qs = {"p10": 0.10, "p25": 0.25, "p50": 0.50, "p75": 0.75, "p90": 0.90}
    out: dict[str, Any] = {
        "count": len(times),
        "fastest_seconds": int(min(times)),
        "slowest_seconds": int(max(times)),
        "fastest": seconds_to_time(min(times)),
        "slowest": seconds_to_time(max(times)),
    }
    for label, q in qs.items():
        val = float(s.quantile(q))
        out[f"{label}_seconds"] = int(round(val))
        out[label] = seconds_to_time(val)
    return out


def group_key(parts: dict[str, Any]) -> str:
    return "|".join(f"{k}={v}" for k, v in parts.items() if v is not None and str(v) != "")


def make_group(df: pd.DataFrame, filters: dict[str, Any], label: str) -> tuple[str, dict[str, Any]]:
    sub = df.copy()
    for col, val in filters.items():
        sub = sub[sub[col].astype(str) == str(val)]
    times = sorted(int(x) for x in sub["chip_seconds"].dropna().astype(int).tolist())
    key = group_key(filters)
    payload = {
        "label": label,
        "filters": filters,
        "times": times,
        **quantiles(times),
    }
    return key, payload


def build_groups(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Build only the group families the frontend actually queries:
    event, event+gender, event+age_group, event+gender+age_group.
    Each carries the sorted `times` array so the browser can do exact-percentile
    lookups via binary search.
    """
    groups: dict[str, dict[str, Any]] = {}
    for event in sorted(df["event"].dropna().unique()):
        key, payload = make_group(df, {"event": event}, f"{event} overall")
        groups[key] = payload

        event_df = df[df["event"] == event]
        genders = [g for g in sorted(event_df["gender"].dropna().unique()) if str(g).strip()]
        age_groups = [ag for ag in sorted(event_df["age_group"].dropna().unique()) if ag and ag != "Unknown"]

        for gender in genders:
            key, payload = make_group(df, {"event": event, "gender": gender}, f"{event} {gender}")
            groups[key] = payload

        for ag in age_groups:
            key, payload = make_group(df, {"event": event, "age_group": ag}, f"{event} age {ag}")
            groups[key] = payload

        for gender in genders:
            for ag in age_groups:
                key, payload = make_group(
                    df,
                    {"event": event, "gender": gender, "age_group": ag},
                    f"{event} {gender} {ag}",
                )
                if payload.get("count"):
                    groups[key] = payload
    return groups


def build_team_map(teams_path: Path | None) -> dict[str, list[dict[str, Any]]]:
    if not teams_path or not teams_path.exists():
        return {}
    teams = pd.read_csv(teams_path)
    out: dict[str, list[dict[str, Any]]] = {}
    if "member_result_pk" not in teams.columns:
        return out
    for row in teams.itertuples(index=False):
        result_pk = getattr(row, "member_result_pk", None)
        if result_pk is None or (isinstance(result_pk, float) and math.isnan(result_pk)):
            continue
        result_pk = str(result_pk).strip()
        if not result_pk:
            continue
        item = {
            "team_name": getattr(row, "team_name", None),
            "team_rank": safe_int(getattr(row, "team_rank", None)),
            "team_avg_chip_time": getattr(row, "team_avg_chip_time", None),
            "member_order": safe_int(getattr(row, "member_order", None)),
        }
        out.setdefault(result_pk, []).append(item)
    return out


def stringify_pk(value: Any) -> str:
    """Render Laurel result_pk as a clean integer string when possible.

    Pandas reads the column as float on CSV load, so '8889243' arrives as
    8889243.0; we drop the trailing '.0' without altering string-valued pks.
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    s = str(value).strip()
    if s.endswith(".0") and s[:-2].lstrip("-").isdigit():
        return s[:-2]
    return s


def build_rows(df: pd.DataFrame, privacy: str, team_map: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, row in df.sort_values(["event", "chip_seconds", "gun_seconds", "bib"], na_position="last").iterrows():
        result_pk = stringify_pk(row.get("result_pk"))
        chip_seconds = safe_int(row.get("chip_seconds"))
        if chip_seconds is None:
            continue
        event = str(row.get("event") or "")
        distance = EVENT_DISTANCE_MILES.get(event) or safe_float(row.get("distance_miles"))
        rows.append(
            {
                "event": event,
                "bib": safe_int(row.get("bib")),
                "name": display_name(row, privacy),
                "gender": safe_str(row.get("gender")),
                "age": safe_int(row.get("age")),
                "age_group": safe_str(row.get("age_group")) or "Unknown",
                "division": safe_str(row.get("division")),
                "chip_seconds": chip_seconds,
                "chip_time": safe_str(row.get("chip_time")) or seconds_to_time(chip_seconds),
                "gun_seconds": safe_int(row.get("gun_seconds")),
                "gun_time": safe_str(row.get("gun_time")),
                "pace_seconds_per_mile": safe_int(row.get("pace_seconds_per_mile")),
                "pace_min_mile": safe_str(row.get("pace_min_mile")),
                "distance_miles": distance,
                "place_overall": safe_int(row.get("place_overall")),
                "place_gender_rank": safe_int(row.get("place_gender_rank")),
                "place_div": safe_str(row.get("place_div")),
                "result_pk": result_pk or None,
                "teams": team_map.get(result_pk, []),
            }
        )
    return rows


_DIV_RANK_PREFIX = re.compile(r"^\d+\s+")


def normalize_division(value: Any) -> str:
    """Strip the leading per-runner rank from Laurel's place_div strings.

    Examples: '1965 M20-29' -> 'M20-29', '1 M Overall' -> 'M Overall'.
    Returns '' when the input has no recognizable division.
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return ""
    return _DIV_RANK_PREFIX.sub("", s).strip()


def clean_results(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.copy()
    # Ensure seconds exist.
    if "chip_seconds" not in df.columns and "chip_time" in df.columns:
        df["chip_seconds"] = df["chip_time"].map(parse_time_to_seconds)
    if "gun_seconds" not in df.columns and "gun_time" in df.columns:
        df["gun_seconds"] = df["gun_time"].map(parse_time_to_seconds)
    if "pace_seconds_per_mile" not in df.columns and "pace_min_mile" in df.columns:
        df["pace_seconds_per_mile"] = df["pace_min_mile"].map(parse_time_to_seconds)

    df = df[df["chip_seconds"].notna()].copy()
    df["chip_seconds"] = df["chip_seconds"].astype(int)
    df["age_group"] = df.get("age", pd.Series([None] * len(df))).map(age_group)

    # Laurel emits NaN as the string "nan" once it round-trips through CSV.
    # Normalize both shapes to a real pandas NA so group keys aren't polluted.
    if "gender" in df.columns:
        gender = df["gender"].astype(object)
        gender = gender.where(~gender.isna(), None)
        gender = gender.map(lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v).strip())
        df["gender"] = gender.map(lambda v: None if (v in (None, "", "nan", "NaN", "---")) else v)

    df["division"] = df["place_div"].map(normalize_division) if "place_div" in df.columns else ""

    return df


def main() -> int:
    parser = argparse.ArgumentParser(description="Build static-site data from scraped B2B results")
    parser.add_argument("--results", required=True, type=Path, help="data/b2b_2026_results_raw.csv")
    parser.add_argument("--teams", type=Path, default=None, help="data/b2b_2026_teams_raw.csv")
    parser.add_argument("--out", default=Path("site/data"), type=Path)
    parser.add_argument("--privacy", choices=["initials", "full", "none"], default="initials")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    raw = pd.read_csv(args.results)
    df = clean_results(raw)
    team_map = build_team_map(args.teams)
    rows = build_rows(df, args.privacy, team_map)
    groups = build_groups(df)

    generated_at = datetime.now(timezone.utc).isoformat()
    summary = {
        "generated_at": generated_at,
        "privacy": args.privacy,
        "events": sorted(df["event"].dropna().unique().tolist()),
        "distance_miles": EVENT_DISTANCE_MILES,
        "age_groups": [label for _, _, label in AGE_BUCKETS],
        "counts_by_event": df.groupby("event").size().to_dict(),
        "groups": groups,
    }
    results_min = {
        "generated_at": generated_at,
        "privacy": args.privacy,
        "rows": rows,
    }

    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (args.out / "results.min.json").write_text(json.dumps(results_min, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"Saved {args.out / 'summary.json'}")
    print(f"Saved {args.out / 'results.min.json'}")
    print(df.groupby("event").size())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
