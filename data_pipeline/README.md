# Data Pipeline

This folder is intentionally separate from the deployable site. It contains the crawler, data derivation script, Python dependencies, and raw crawl outputs.

## Refresh Site Data

From the repo root:

```bash
./data_pipeline/refresh_site_data.sh
```

Outputs:

- `raw/` contains the full public crawler output.
- `../site/data/` contains the minimized JSON loaded by the browser.

The static site can be hosted from `../site/` without this folder.
