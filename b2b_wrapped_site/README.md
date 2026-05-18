# Bay to Breakers 2026 Wrapped — public-results scraper + lightweight site

This repo is a starter kit for building a lightweight “Spotify Wrapped” style comparison site from the public Laurel Timing Bay to Breakers 2026 results.

It is intentionally scoped to public pages only:

- official leaderboard tables for 12K and 15K Breakers Bonus
- public participant detail pages, if you explicitly enable detail scraping
- public centipede/team result pages
- optional capture of public JSON/XHR responses from split pages, if the browser loads them

Do not use this to bypass login, private endpoints, access controls, or rate limits. Do not scrape or mirror runner photos without permission. The default derived data minimizes names to `First L.` because the site does not need to republish full PII for percentile comparisons.

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium

# 1) Pull official public leaderboard + team pages.
python scripts/scrape_laurelt.py --out data

# Fuller timing pull: also scrape public checkpoint/location tables, when exposed.
python scripts/scrape_laurelt.py --out data --include-locations

# 2) Build lightweight JSON for the static site.
python scripts/derive_site_data.py \
  --results data/b2b_2026_results_raw.csv \
  --teams data/b2b_2026_teams_raw.csv \
  --out public/data \
  --privacy initials

# 3) Serve the static site locally.
python -m http.server 8000 -d public
# Open http://localhost:8000
```

## Optional: participant detail + split-network capture

The leaderboard is enough for the core site. For richer “Wrapped” cards, you can opt into public detail pages and public split/XHR capture.

```bash
# Conservative test run on the first 50 finishers.
python scripts/scrape_laurelt.py --out data --include-details --details-limit 50 --delay 0.35

# Full public detail crawl. This is 25k+ pages; be respectful and slow.
python scripts/scrape_laurelt.py --out data --include-details --details-limit all --delay 0.5
```

The detail scraper saves:

- `data/b2b_2026_participant_details.jsonl`
- `data/detail_network/*.json` for public JSON/XHR responses encountered while loading split pages
- `data/detail_network/*.txt` for public text responses that were not JSON

## Raw data files

After scraping, expect:

- `data/b2b_2026_results_raw.csv` — public leaderboard rows
- `data/b2b_2026_result_links.csv` — participant detail URLs discovered from leaderboard links
- `data/b2b_2026_teams_raw.csv` — team summary rows and visible member rows from the public team-results page
- `data/b2b_2026_location_results_raw.csv` — optional checkpoint/location leaderboard rows from `--include-locations`
- `data/b2b_2026_participant_details.jsonl` — optional participant detail pages
- `public/data/results.min.json` — lightweight runner rows for the browser
- `public/data/summary.json` — distributions and quantiles by event, gender, age group, division, and combos

## Data model

The raw leaderboard scraper normalizes these fields when present:

- `event`
- `event_date`
- `place_overall`
- `place_gender`
- `place_div`
- `bib`
- `last_name`
- `first_name`
- `display_name`
- `gender`
- `age`
- `chip_time`
- `chip_seconds`
- `pace_min_mile`
- `pace_seconds_per_mile`
- `gun_time`
- `gun_seconds`
- `participant_url`
- `result_pk`
- `source_url`

The derived site data adds:

- `age_group`
- `distance_miles`
- `beat_percentile` style calculations are done client-side from distributions

## Privacy defaults

The raw CSV contains the public leaderboard as published. The browser-facing JSON defaults to minimized display names:

- `First L.` for people with a first and last name
- bib number is preserved because many runners search by bib
- full names can be enabled with `--privacy full`, but the lightweight comparison site does not need it

## Deployment

Once `public/data/*.json` exists, the `public/` directory is static and can go on GitHub Pages, Netlify, Cloudflare Pages, or Vercel.

```bash
python -m http.server 8000 -d public
```

## Suggested Wrapped cards

The included frontend computes:

- overall beat percentage
- gender beat percentage
- age-group beat percentage
- gender + age-group beat percentage
- time vs. event median
- pace
- nearest public finishers by time
- team card if the bib appears in team data

If you successfully capture split data from public split pages, you can add:

- Hayes Hill survival index
- fastest mile / strongest segment
- negative split card
- “you passed X people after Hayes Hill”

