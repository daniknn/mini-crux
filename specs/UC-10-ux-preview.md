# UC-10 — Reviewable UI without a database

**Status:** `done` · **Depends on:** UC-4, UC-5, UC-7, UC-8 · **Blocks:** the Daily Brew
design review

## Goal

Give the design review a URL.

Seven surfaces have shipped across UC-4 through UC-8 and **not one of them has been looked at
in a browser.** They are correct against the database — every query is tested, every empty
state is tested, the copy is reviewed — and that is a different claim from "the spacing is
right, the contrast passes AA, and the focus ring is visible."

## Why this is a UC and not an afternoon

The obstacle is not effort, it is that the app cannot currently render any of these pages, and
the reason is structural rather than incidental.

Booted locally with no environment at all (`pnpm next dev -p 3210`):

| Path | Result |
|---|---|
| `/` | `307` → `/novedades` |
| `/sign-in` | `200`, 111 KB — Clerk 6 keyless mode provisions a throwaway dev instance |
| `/listas` | **`500`** inside `withWorkspace` |

Every dashboard page opens with `withWorkspace(…)`, which reads `{ userId, orgId }` from
`auth()`, opens a Postgres connection as `authenticator`, and switches to `authenticated`
inside the transaction. Three things have to exist before a single pixel renders: a Clerk
session, a Postgres instance with the migrations applied, and — the one UC-9 was written
about — a `workspaces` row matching the session's `org_id`.

And even with all three, the reward is **seven empty states**, because an empty panel is what
a fresh database has. The surfaces worth reviewing — a gallery of censored creatives, an
analysis that refuses on a thin panel, a suspect crawl warning — are precisely the ones a
brand-new environment cannot produce.

So the review is blocked behind five accounts that do not exist yet (Clerk, Supabase, Apify,
Vercel, Doppler) **and** eight weeks of crawling. Inverting that order is the whole point:
review the design now, connect the tools after.

## Scope

**In:** a `/ux` route tree, reachable in `next dev`, rendering all seven surfaces from typed
fixtures; each surface's meaningful states, not just its populated one; an index page listing
them; the extraction of presentation out of the seven page files that makes this possible.

**Out:** any change to markup, Tailwind classes, copy, or component structure. This UC makes
the UI *visible*; the changes the review asks for are the next UC. Also out: fixtures for the
webhook and health routes (not surfaces), Storybook (a build system for one reviewer), and
visual regression snapshots (worth having once the design has settled — not before).

## Design

### 1. Safety is structural, not a flag

A preview tree that renders tenant surfaces is a natural place to leak tenant data. The
defense is that **it has nothing to leak.**

Nothing under `(preview)/` imports `server/db.ts`, `@clerk/*`, `@mini-crux/db`, or any
Supabase client. The view components it renders are pure functions of their props, the props
come from fixture modules, and the fixture modules are literals. There is no code path from
`/ux` to a credential, a connection, or a session — not one that is disabled, one that does
not exist.

`NODE_ENV !== 'production'` still gates the route, because defense in depth is cheap. But the
gate is the second line. The first is a **test that reads the import graph** of every file
under `(preview)/` and fails if any of them reaches the server. A flag can be flipped by
someone who does not know why it is there; an import that is not written cannot be.

### 2. The extraction is mechanical, and stays mechanical

Each of the seven pages is one async function that fetches at the top and returns JSX below.
The extraction splits exactly there:

```
apps/web/src/views/novedades.tsx      ← the JSX, as a pure component taking props
apps/web/src/app/(dashboard)/novedades/page.tsx   ← the fetch, then <NovedadesView …/>
apps/web/src/app/(preview)/ux/novedades/page.tsx  ← a fixture, then <NovedadesView …/>
```

**The JSX moves verbatim. Not one class changes.** This is a rule and not a preference: the
purpose of the preview is to show the real interface, and markup "improved" in transit shows
something else. A review of a cleaned-up copy is worthless, and worse than worthless if it is
mistaken for a review of the product.

The private helper components inside each page (`Section`, `WatchlistCard`, and their
equivalents) move with the JSX and stay private to the view module. The diff on the page files
should be an import, a fetch, and a return.

### 3. The props are the query return types, not new ones

Each view's props are typed with the types already exported from `@mini-crux/db/dashboard` —
`Watchlist`, `CreativeSummary`, `CreativeDetail`, `LatestAnalysis`, `MetricDistribution`,
`StructuralProfile`, `ChangeFeedEntry`, `LatestProxyValidation`, and the panel-health shape.

That choice is what keeps the fixtures honest. A fixture typed against a hand-written
interface drifts the moment a query grows a column, and drifts *silently* — the preview keeps
rendering, and it renders something the product no longer produces. Typed against the real
return type, the same change is a red squiggle in the fixture file. `tsc --noEmit` already
runs in CI, so this costs nothing to enforce.

### 4. `ClerkProvider` moves down one level

Next.js allows a second root layout only when there is no `app/layout.tsx` above it, and there
is one — it carries the Daily Brew fonts, `globals.css`, `lang="es-MX"`, and `ClerkProvider`.
Anything under `(preview)/` therefore inherits `ClerkProvider`, which in keyless mode reaches
out to provision a dev instance. A design review that fails when the network is down, over a
provider nothing on the page uses, is a bad trade.

So `ClerkProvider` moves out of the root layout and into the two places that actually need it:
`(dashboard)/layout.tsx`, whose `OrganizationSwitcher` and `UserButton` are Clerk client
components, and a new `sign-in/layout.tsx` for `<SignIn/>`. `auth()` is unaffected — it reads
the request on the server and has never needed the provider. The root layout keeps the fonts
and the stylesheet, which is what the preview needs from it and all it needs.

This is a real change to the signed-in app's tree, so it is listed in the acceptance criteria
rather than buried here: the dashboard must still render its Clerk chrome afterwards.

### 5. Fixtures cover the states worth arguing about

One populated screenshot per surface would miss most of what the review is for. The states
below are chosen because each one has a distinct visual treatment that has never been seen:

| Surface | States |
|---|---|
| `/ux/novedades` | populated (launched · discovered · stopped) · no crawls yet · calm window |
| `/ux/creativos` | populated gallery · censored and gapped durations · missing poster · empty |
| `/ux/creativos/[id]` | full detail with transcript, features and semantic tags · sparse |
| `/ux/estructura` | profile vs. baseline · single-advertiser · empty |
| `/ux/analisis` | a finding · **refused: panel too thin** · no run yet |
| `/ux/validacion-proxy` | a positive verdict · a null result · not yet run |
| `/ux/listas` | active and paused · suspect and failed run counts · no watchlists |

The refusal and the suspect-crawl states matter most. They are the product's honesty
mechanisms — the places where it declines to answer — and they are the least likely to be
exercised by any environment we could stand up instead.

### 6. The preview says what it is, on every page

A banner above every preview surface, in Mexican Spanish, stating that the data is invented
and the controls do nothing. `/ux/listas` renders real Client Components wired to real Server
Actions; those actions call `withWorkspace` and will throw. The banner is what keeps that from
reading as a bug, and keeps a screenshot of the preview from being mistaken for a screenshot
of the product.

## Data model

**None.** No migration, no table, no column, and no database of any kind — which is the point.

## Rules

1. No file under `app/(preview)/` may import `server/`, `@clerk/*`, `@mini-crux/db`, or a
   Supabase client, directly or transitively. Asserted by a test over the import graph.
2. The preview tree returns `notFound()` when `NODE_ENV === 'production'`. Defense in depth,
   not the primary guarantee.
3. Extracted JSX is byte-identical to what it replaced, modulo the props it now receives. No
   class, element, attribute, or string changes in this UC.
4. Fixtures are typed with the exported query return types. No hand-written prop interfaces.
5. Every preview page renders the fictional-data banner.
6. The seven dashboard routes keep rendering exactly what they rendered before — the
   extraction is a refactor and their existing tests must pass unchanged.

## Acceptance criteria

- [ ] `/ux` lists every surface and every state, and each link renders without a database,
      without Clerk, and without any environment variable set
- [ ] All seven surfaces render from fixtures, in both a populated and an empty state
- [ ] `/ux/analisis` shows the refusal-on-a-thin-panel state
- [ ] `/ux/listas` shows suspect and failed run counts, and its forms render (inert)
- [ ] `/ux/creativos` shows a censored duration, a gapped duration, and a missing poster
- [ ] No file under `(preview)/` imports the server, Clerk, or the database — asserted by a
      test, not by inspection
- [ ] The preview tree is `notFound()` under `NODE_ENV=production`
- [ ] The signed-in dashboard still renders `OrganizationSwitcher` and `UserButton` after
      `ClerkProvider` moves out of the root layout
- [ ] `pnpm typecheck` and `pnpm test` are green; no existing test changed to accommodate the
      extraction

## Test plan

| What | How | Expected |
|---|---|---|
| Isolation | walk the import graph from every `(preview)/` file | no `server/`, `@clerk/*`, `@mini-crux/db`, Supabase |
| Production gate | render the preview layout with `NODE_ENV=production` | `notFound()` |
| Fixture typing | `tsc --noEmit` | fixtures satisfy the real query return types |
| Extraction is a no-op | existing dashboard tests | pass unchanged |
| Clerk relocation | render `(dashboard)/layout.tsx` | Clerk chrome present |
| Every state reachable | the `/ux` index against the route tree | no listed state without a route, no route without a listing |

**Quick CLI check:**
```bash
pnpm --filter @mini-crux/web dev
# then open http://localhost:3000/ux — no .env, no database, no Clerk account
```

## Upgrade path

- Visual regression snapshots over the `/ux` routes, once the design has settled enough that a
  diff means a regression rather than progress.
- Fixtures reused as the seed for a local demo workspace, if a demo ever needs a real database
  behind it.
- Whatever the review asks for lands as UC-11, against these same fixtures — which is the
  second reason to build them.
