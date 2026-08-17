# Mini Crux

Competitive creative-intelligence for performance marketing in Mexico.

Mini Crux watches competitor advertisers on the public Meta Ad Library, extracts structural
features from their video creatives (cut pace, on-screen text, transcript, audio energy), and
correlates those features against creative **survival** — how long an advertiser keeps paying to
run a creative.

## The honest version

Meta publishes **no performance metrics** for commercial ads in Mexico — no impressions, no
spend, no CTR, no ROAS. So this product does not measure performance and never claims to. It
measures *revealed advertiser behavior*: performance marketers kill losing creatives fast and
keep winners running, so how long a creative survives is a real signal, just an indirect one.

That signal only exists if you watch every day. **The panel cannot be backfilled** — which is
why daily ingestion (UC-1) ships before analysis, before the dashboard, before anything.

The survival proxy is currently **unvalidated**. See `ARCHITECTURE.md` §10 for that and the
other accepted debts.

## Docs

| Doc | What's in it |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | product behavior, data model, survival semantics, risks |
| [`CLAUDE.md`](CLAUDE.md) | how to build inside this repo |
| [`specs/`](specs/README.md) | one spec per use case; nothing gets built without one |

## Stack

Next.js 15 + Clerk + Supabase (Postgres/RLS/Storage) · Python 3.12 worker on Fly.io for video
feature extraction · Apify for Ad Library ingestion · Doppler for secrets.

## Local dev

```bash
doppler run -- pnpm dev
```
