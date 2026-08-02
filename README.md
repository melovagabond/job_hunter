<h1 align="center">A slightly less annoying way to hunt for a job</h1>
<p align="center">
  <a href='https://ko-fi.com/melovagabond' target='_blank'><img height='35' style='border:0px;height:46px;' src='https://az743702.vo.msecnd.net/cdn/kofi3.png?v=0' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
</p>

> Self-hosted job hunting pipeline. Pulls from job APIs (scraping only
> as a last resort), filters against your criteria, dedupes syndicated
> postings, and tracks every application through an enforced lifecycle.
> One place instead of five recruiters and six apps.

## What it does today

- **Six live sources**: Adzuna, USAJobs, Remotive, RemoteOK, plus
  per-company Greenhouse and Lever boards. Each adapter normalizes to
  one common shape.
- **Config-driven matching**: title allowlist and exclusions, salary
  floor (compared against the max of a posted range), and a geo rule of
  within 50 miles of Philadelphia OR remote. Every accept and reject
  stores its reasons.
- **Dedupe**: a hash of normalized company+title, so the same role
  syndicated across boards occupies one row and one application slot.
- **SQLite ledger with an enforced state machine**: illegal transitions
  throw, every change lands in an audit table.
- **Weekly governor**: hard cap of 100 applications per ISO week, and a
  new week does not start until the previous batch of applied jobs has
  been manually sorted into follow-up states.
- **Dashboard**: zero-dependency web UI where the nav is the state
  machine itself. Review matches, queue, record applications, work the
  follow-up backlog.

Planned next: the apply engine (programmatic submission for Greenhouse
and Lever postings through the same governed endpoint), resume variant
storage, and contact-info config.

## Architecture

    worker (cron, 3x daily)                    api (:3001)
      sources/*  -> normalize -> dedupe          dashboard (/)
                 -> match     -> SQLite  <----   JSON endpoints (/api/*)
                                  data/jobs.sqlite

## Quick start (local)

Requires Node 20+ (better-sqlite3 compiles a native module; old Node
will fail loudly at install).

    npm install
    cp .env.example .env      # then fill it in, see comments in the file
    npm test                  # 23 tests, no network needed
    npm run fetch:once        # single pipeline run
    npm run api               # dashboard at http://localhost:3001
    npm run worker            # cron mode: 7am, 1pm, 7pm Eastern

Without API keys, Adzuna and USAJobs skip themselves and you only get
the remote-only sources. That means zero Philadelphia-area results, so
get the keys; both are free and the .env.example comments say exactly
where.

The other half of configuration lives in `config/`:

| File                   | Controls                                          |
| ---------------------- | ------------------------------------------------- |
| `config/criteria.json` | titles, salary floor, geo rule, weekly cap        |
| `config/sources.json`  | which sources run; your Greenhouse/Lever targets  |

`sources.json` has empty `boards[]` (Greenhouse) and `companies[]`
(Lever) arrays. Those are your target-company lists: add the token from
a company's job board URL, e.g. `"cloudflare"` from
boards.greenhouse.io/cloudflare. These two sources matter most because
they are the ones the future apply engine can actually submit to.

## Docker

    cp .env.example .env      # fill it in first
    docker compose up -d --build
    docker compose logs -f worker

Two services from one image: `api` (dashboard on 127.0.0.1:3001) and
`worker` (scheduled fetching). The SQLite ledger lives in `./data` on
the host; back that directory up and you have backed up everything.

The API has no authentication yet and compose deliberately binds it to
localhost only. Do not expose it to the internet as-is.

## The lifecycle

    new -> matched -> queued -> applied -> needs_followup -> followed_up
             |          |         |              |
             +----------+---------+--- skipped / rejected

Illegal transitions throw at the database layer and 409 at the API, so
nothing skips a step or quietly corrupts the weekly count. `skipped`
jobs can be manually rescued back to `matched` from the dashboard.

Entering `applied` is only possible through `POST /api/jobs/:id/apply`,
which is gated by the governor and records the application against the
current ISO week in one motion.

## Testing

    npm test

Covers the matcher, dedupe, geo math, state machine enforcement,
governor semantics, and the API contract. Tests write to a throwaway
database in /tmp and never touch your real ledger.

## Troubleshooting

- `injected env (0)` at startup: your .env is empty, keyed sources
  will skip.
- Adzuna 401: bad app id/key pair.
- USAJobs 401: the email in USAJOBS_EMAIL must exactly match the one
  registered with the key.
- Everything lands in `skipped`: open the dashboard, read the stored
  match reasons, and tune `config/criteria.json` with evidence.
- Reset to a clean slate: stop everything, delete `data/jobs.sqlite*`.

## Author

**Melovagabond**