<h1 align="center">job_hunter</h1>

> Private, self-hosted job discovery and application ledger. It gathers
> postings from approved APIs and public ATS boards, scores them against a
> local resume and explicit constraints, deduplicates syndicated listings,
> and tracks applications through an enforced lifecycle.

## Current capabilities

- Ten source adapters: Adzuna, USAJobs, Remotive, RemoteOK, Jobicy,
  Greenhouse, Lever, Ashby, SmartRecruiters, and Workable.
- Outbound searches plus manual/batch import for LinkedIn, Indeed, and Dice.
- SQLite FTS5 search over titles, companies, locations, and descriptions.
- Private local resume profile with explainable skill overlap, missing-skill,
  role, eligibility, and data-confidence signals.
- Posting provenance, refreshes, first/last-seen timestamps, stale detection,
  salary normalization, and source-run yield/error metrics.
- Structured review feedback, a 72-hour digest, and filters for source, age,
  score, recency, and salary.
- An enforced application state machine and weekly application governor.

## Requirements

- Node.js 20 or newer. Node 22 is used by the Docker image.
- npm.
- Optional: Docker Engine plus the Docker Compose v2 plugin (`docker compose`).
- A plain-text or Markdown resume.

## Local setup checklist

### 1. Install and create private configuration

```sh
npm ci
cp .env.example .env
```

`.env` and all files under `data/docs/`, `data/import/`, and `data/backups/`
are ignored by Git. Never put real credentials in `.env.example`.

### 2. Add the resume

Place the canonical plain-text or Markdown resume here:

```text
data/docs/resume.cv
```

Alternatively, set `RESUME_PATH` in `.env`. Generate the private structured
profile and inspect only the extracted skill labels:

```sh
npm run profile
```

The generated `data/docs/candidate-profile.json` stays local. Update the
resume and rerun `npm run profile && npm run reindex` whenever experience or
skills change.

### 3. Configure API-backed sources

Edit `.env` and replace placeholders with real values:

| Source | Variables | Setup |
| --- | --- | --- |
| Adzuna | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | Register a free application at `developer.adzuna.com`. |
| USAJobs | `USAJOBS_API_KEY`, `USAJOBS_EMAIL` | Request a key at `developer.usajobs.gov`; the email must exactly match the registration. |

Placeholder values are treated as unconfigured, so these sources skip cleanly
until valid credentials are present.

Remotive, RemoteOK, and Jobicy require no keys. Their queries are derived from
the resume and title criteria where supported.

### 4. Configure target-company ATS boards

Edit `config/sources.json`. Add only companies you want to monitor:

| ATS | Configuration | Identifier location |
| --- | --- | --- |
| Greenhouse | `greenhouse.boards[]` | Token after `boards.greenhouse.io/` or `job-boards.greenhouse.io/`. |
| Lever | `lever.companies[]` | Company slug after `jobs.lever.co/`. |
| Ashby | `ashby.boards[]` | Board name after `jobs.ashbyhq.com/`. |
| SmartRecruiters | `smartrecruiters.companies[]` | Identifier after `careers.smartrecruiters.com/`. |
| Workable | `workable.accounts[]` | Account subdomain shown in the Workable careers URL. |

Example:

```json
{
  "greenhouse": { "enabled": true, "boards": ["company-token"] },
  "lever": { "enabled": true, "companies": ["company-slug"] },
  "ashby": { "enabled": true, "boards": ["company-board"] },
  "smartrecruiters": { "enabled": true, "companies": ["CompanyIdentifier"] },
  "workable": { "enabled": true, "accounts": ["account-subdomain"] }
}
```

Keep the other keys already present in `config/sources.json`; the example is
only showing the fields to populate.

### 5. Configure matching and eligibility

Edit `config/criteria.json`:

- `titles.must_match_any`: high-confidence role titles.
- `titles.resume_assisted`: broader titles that require at least two resume
  skill signals.
- `titles.exclude`: titles that are always rejected.
- `salary.floor_usd` and `salary.accept_missing_salary`.
- `location.home`, `radius_miles`, remote policy, and metro keywords.
- `eligibility.allow_contract`.
- `eligibility.allow_clearance_required`.
- `eligibility.require_sponsorship`.
- `weekly_apply_cap`.

The eligibility defaults are permissive because citizenship, clearance, and
sponsorship status cannot safely be inferred from a resume. Set them explicitly.

### 6. Import LinkedIn, Indeed, and Dice results

Those sites do not provide an approved general job-search feed for this use.
The dashboard provides outbound searches; open a result and use **Add job** to
index it locally.

For batch imports:

```sh
mkdir -p data/import
cp config/import.example.json data/import/jobs.json
```

Edit `data/import/jobs.json`, or append one JSON object per line to
`data/import/alerts.jsonl`. This JSONL inbox is suitable for a user-controlled
email-alert automation. Each record may include:

```json
{
  "source": "linkedin",
  "sourceId": "site-posting-id",
  "title": "Senior Cloud Security Engineer",
  "company": "Example Company",
  "location": "Remote - US",
  "remote": true,
  "salaryMin": 150000,
  "salaryMax": 190000,
  "currency": "USD",
  "url": "https://example.com/job",
  "description": "Full posting text",
  "postedAt": "2026-09-13",
  "expiresAt": null,
  "employmentType": "full-time",
  "workplaceType": "remote",
  "seniority": "senior"
}
```

Do not automate scraping LinkedIn, Indeed, or Dice pages. Import content you
personally saved or received through your own alerts.

### 7. Build the first index and launch

```sh
npm run profile
npm run fetch:once
npm run reindex
npm test
```

Start these in separate terminals:

```sh
npm run api
npm run worker
```

Open <http://127.0.0.1:3001>. The worker runs once at startup and then at 7am,
1pm, and 7pm America/New_York by default.

## Environment reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADZUNA_APP_ID` | none | Adzuna application ID. |
| `ADZUNA_APP_KEY` | none | Adzuna application key. |
| `USAJOBS_API_KEY` | none | USAJobs API key. |
| `USAJOBS_EMAIL` | none | Email registered with USAJobs. |
| `JOB_DB_PATH` | `./data/jobs.sqlite` | SQLite ledger location. |
| `RESUME_PATH` | `./data/docs/resume.cv` | Resume used for local matching. |
| `FETCH_CRON` | `0 7,13,19 * * *` | Fetch schedule in America/New_York. |
| `API_HOST` | `127.0.0.1` | API bind address. Keep this local unless authentication is added. |
| `API_PORT` | `3001` | Dashboard/API port. |

## Routine operation

```sh
npm run fetch:once   # fetch all enabled sources immediately
npm run reindex      # re-score every posting after config/resume changes
npm run profile      # regenerate the local candidate profile
npm run backup       # online-safe SQLite backup under data/backups/
npm test             # no network required
```

Useful endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Database status and last successful worker run. |
| `GET /api/stats` | Lifecycle counts, governor, and source summaries. |
| `GET /api/metrics` | Source yield/errors and structured feedback totals. |
| `GET /api/digest?hours=72` | Highest-scoring recent matches. |
| `GET /api/search?q=terraform` | Local FTS5 search. |
| `GET /api/profile` | Extracted local profile, not the resume text. |

Postings not seen for `stale_after_days` in `config/sources.json` are hidden
from normal queues but retained in the ledger. Reappearing postings are
refreshed and made active again. Source errors do not erase postings.

When skipping or rejecting a job, record a reason. Feedback metrics make it
possible to identify weak sources and tune title/skill rules with evidence.

## Docker

Confirm that both commands work first:

```sh
docker --version
docker compose version
```

Then:

```sh
cp .env.example .env
# complete .env and config/sources.json
docker compose up -d --build
docker compose logs -f worker
docker compose ps
```

Compose binds the API to `127.0.0.1:3001`, mounts `./data`, and includes an API
health check. The worker container shares the same SQLite ledger.

## Data model and lifecycle

Each canonical job can have multiple `job_sources` records. Refreshes update
salary, description, location, provenance, and last-seen state without
discarding application history.

```text
new -> matched -> queued -> applied -> needs_followup -> followed_up
         |          |         |              |
         +----------+---------+--- skipped / rejected
```

Entering `applied` is only possible through `POST /api/jobs/:id/apply`. The
governor check, status transition, history entry, and application record are
one SQLite transaction.

## Troubleshooting

- Keyed source skips: replace placeholder values in `.env`.
- Adzuna 401: verify the application ID/key pair.
- USAJobs 401: verify that `USAJOBS_EMAIL` exactly matches the registered email.
- ATS source returns zero: verify the company identifier in the public board URL.
- Everything is skipped: inspect stored reasons, then adjust title, salary,
  location, or eligibility settings and run `npm run reindex`.
- Worker appears stale: check `/api/health`, `/api/metrics`, and worker logs.
- Docker command missing: install the Docker Compose v2 plugin or use the two
  local npm processes.
- Database recovery: restore the newest file from `data/backups/` while both
  processes are stopped.

## Security boundary

The app has no user authentication. Keep `API_HOST=127.0.0.1` and do not expose
the dashboard through a public reverse proxy. Resume, imported postings,
application notes, backups, and the SQLite ledger are private local data.
