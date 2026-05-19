# Bay to Breakers 2026 Wrapped

This repo has two separate parts:

- `site/` — the deployable static site. It contains only HTML, CSS, JS, and prebuilt JSON data.
- `data_pipeline/` — local-only Python tooling that crawls public Laurel Timing pages and regenerates `site/data/*.json`.

The site does not run Python, Playwright, scraping code, or data derivation in production.

It is intentionally scoped to public pages only:

- official leaderboard tables for 12K and 15K Breakers Bonus
- public participant detail pages, if you explicitly enable detail scraping
- public centipede/team result pages
- optional capture of public JSON/XHR responses from split pages, if the browser loads them

Do not use this to bypass login, private endpoints, access controls, or rate limits. Do not scrape or mirror runner photos without permission. The default derived data minimizes names to `First L.` because the site does not need to republish full PII for percentile comparisons.

## One-time setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r data_pipeline/requirements.txt
python -m playwright install chromium
```

## Refresh the data

Run this locally when you want to update the race data:

```bash
./data_pipeline/refresh_site_data.sh
```

That command writes raw crawler outputs to `data_pipeline/raw/` and browser-ready JSON to `site/data/`.

For a fuller timing pull, pass scraper flags through to the refresh script:

```bash
./data_pipeline/refresh_site_data.sh --include-locations
```

## Run the static site

```bash
python -m http.server 8000 -d site
# Open http://localhost:8000
```

You can deploy `site/` directly to GitHub Pages, Netlify, Cloudflare Pages, Vercel, or any static host.

## Stanford / Cardinal edition

`site/stanford.html` is a separate Stanford-only leaderboard that now requires verified email auth.

### Auth model

- Email sign-in is handled with Supabase magic links.
- Only `@stanford.edu` and `@alumni.stanford.edu` accounts are allowed.
- Leaderboard rows are stored in Supabase with RLS enabled.
- One entry per user per event per season is enforced by DB unique constraint.

### Setup (one-time)

1. Create a Supabase project.
2. In Supabase SQL editor, run `supabase/stanford_leaderboard.sql`.
3. In Supabase Auth settings, make sure email sign-in is enabled.
4. Copy `site/auth-config.example.js` to `site/auth-config.js` and fill in:
   - `supabaseUrl`
   - `supabaseAnonKey`
   - optional `allowedEmailDomains`
   - optional `raceSeason`
5. Deploy `site/` normally.

### Data sources on the Stanford page

- `registered_bibs` in `site/data/stanford.json` — Stanford-affiliated bibs present in official Laurel data (joined to official chip time).
- `unregistered` in `site/data/stanford.json` — manually curated self-reported rows.
- `stanford_leaderboard_entries` table in Supabase — verified, signed-in user submissions from the form.

The page still shows each verified user their percentile vs. the full Bay to Breakers field for comparison.

## Optional: participant detail + split-network capture

The leaderboard is enough for the core site. For richer “Wrapped” cards, you can opt into public detail pages and public split/XHR capture.

```bash
# Conservative test run on the first 50 finishers.
./data_pipeline/refresh_site_data.sh --include-details --details-limit 50 --delay 0.35

# Full public detail crawl. This is 25k+ pages; be respectful and slow.
./data_pipeline/refresh_site_data.sh --include-details --details-limit all --delay 0.5
```

The detail scraper saves:

- `data_pipeline/raw/b2b_2026_participant_details.jsonl`
- `data_pipeline/raw/detail_network/*.json` for public JSON/XHR responses encountered while loading split pages
- `data_pipeline/raw/detail_network/*.txt` for public text responses that were not JSON

## Raw data files

After scraping, expect:

- `data_pipeline/raw/b2b_2026_results_raw.csv` — public leaderboard rows
- `data_pipeline/raw/b2b_2026_result_links.csv` — participant detail URLs discovered from leaderboard links
- `data_pipeline/raw/b2b_2026_teams_raw.csv` — team summary rows and visible member rows from the public team-results page
- `data_pipeline/raw/b2b_2026_location_results_raw.csv` — optional checkpoint/location leaderboard rows from `--include-locations`
- `data_pipeline/raw/b2b_2026_participant_details.jsonl` — optional participant detail pages
- `site/data/results.min.json` — lightweight runner rows for the browser
- `site/data/summary.json` — distributions and quantiles by event, gender, age group, division, and combos

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

## Suggested Wrapped cards

The included frontend computes:

- overall beat percentage
- gender beat percentage
- age-group beat percentage
- gender + age-group beat percentage
- time vs. event median
- pace
- rank among finishers with the same first name
- nearest public finishers by time
- team card if the bib appears in team data

If you successfully capture split data from public split pages, you can add:

- Hayes Hill survival index
- fastest mile / strongest segment
- negative split card
- “you passed X people after Hayes Hill”
