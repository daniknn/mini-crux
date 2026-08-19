import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isPreviewEnabled } from './gate.ts'
import { PREVIEW_SURFACES } from './ux/catalog.ts'

/**
 * What actually keeps `/ux` safe.
 *
 * The `NODE_ENV` check in `layout.tsx` is the second line and it is tested at the bottom of
 * this file. The first line is that this tree has nothing to leak: no file reachable from
 * `(preview)/` imports the server, Clerk, `@mini-crux/db` or a Supabase client at runtime, so
 * a route left reachable in production renders invented numbers and stops there.
 *
 * That property is invisible. Nothing breaks when someone adds `import { withWorkspace }` to a
 * preview page — it works, locally, against whatever database that laptop happens to reach,
 * and the preview quietly becomes a surface that needs credentials. This test is the only
 * thing that would notice, so it walks the graph rather than checking the eight entry points.
 *
 * THREE THINGS MAKE THE WALK NON-OBVIOUS
 *
 * `import type` is erased by the compiler, so a type-only edge to `@mini-crux/db/dashboard` is
 * not an edge at all — and the views legitimately have several, because their props *are* the
 * query return types (`specs/UC-10-ux-preview.md` §3). Counting them would force the fixtures
 * to restate every shape locally, which is the drift this design exists to prevent.
 *
 * The walk is transitive. A preview page importing a view that imports the server is the same
 * failure as importing the server directly, and it is the more likely one: nobody adds
 * `pg` to a page under `(preview)/`, and somebody will eventually add a data helper to a file
 * under `views/`.
 *
 * `@mini-crux/analysis` is allowed through as a *value* import. It is pure arithmetic and
 * vocabulary — no I/O, no client, no env — and `views/analisis.tsx` needs `ANALYSIS_FEATURES`
 * at runtime to render the "sin medir" cards. Allowing it is a judgement, so it is spelled out
 * here rather than left to whoever reads the failure.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PREVIEW_ROOT = HERE
const SRC_ROOT = resolve(HERE, '../..')

/**
 * Module specifiers a file in this graph may not import for its value.
 *
 * Each one is a different way to reach a credential: `server/` holds the pooled connection and
 * the workspace resolution, `@clerk/*` holds the session, `@mini-crux/db` holds the queries and
 * `pg`, and `@supabase/*` holds the storage client that signs poster URLs.
 */
const FORBIDDEN: { test: (specifier: string, fromFile: string) => boolean; why: string }[] = [
  {
    test: (spec, from) => resolveRelative(spec, from)?.startsWith(join(SRC_ROOT, 'server')) === true,
    why: 'src/server holds the pooled Postgres connection and the workspace resolution',
  },
  { test: (spec) => spec.startsWith('@clerk/'), why: 'Clerk holds the session' },
  {
    test: (spec) => spec === '@mini-crux/db' || spec.startsWith('@mini-crux/db/'),
    why: 'the db package holds the queries and pulls in pg',
  },
  { test: (spec) => spec.startsWith('@supabase/'), why: 'the Supabase client signs storage URLs' },
  { test: (spec) => spec === 'pg' || spec.startsWith('pg/'), why: 'a Postgres driver' },
]

interface Edge {
  specifier: string
  typeOnly: boolean
}

/**
 * Every `from '…'` in a module, and whether the compiler will erase it.
 *
 * Regex rather than a parser on purpose: the repo writes explicit `.ts`/`.tsx` extensions in
 * every relative import, so resolution is a string join, and a parser would be a dependency
 * bought to re-derive information the source already states plainly. `import type {…}` and
 * `export type {…}` are the erased forms; a mixed `import { type A, B }` is not, and is
 * correctly treated as a value edge here.
 *
 * THE SCAN RUNS BACKWARDS, AND THAT IS THE WHOLE POINT
 *
 * The obvious form — `/(?:import|export)\s+([\s\S]*?)\s+from\s+['"]…['"]/g` — reads forwards
 * from the keyword and is *wrong in the direction that matters*. `views/creativos.tsx` line 33
 * is `export type GalleryAdvertiser = Awaited<ReturnType<typeof listAdvertisers>>[number]`:
 * the keyword matches, the lazy `[\s\S]*?` finds no `from` on that line and keeps going until
 * it reaches the next real import — anywhere later in the file — and the clause it captures
 * starts with `type`, so a genuine value import gets recorded as erased and silently dropped.
 * Measured: appending `import { withWorkspace } from '../server/db.ts'` to that file left this
 * suite green. Any `export type X = …` alias above an import will do it, and the views are
 * full of them precisely because their props are the query return types.
 *
 * So anchor on `from '…'` — which is unambiguous — and look *back* to the nearest preceding
 * `import`/`export` keyword. The text between them must look like an import clause
 * (identifiers, braces, commas, `*`, `as`, whitespace); anything containing `=`, `<`, `(` or
 * prose is a type alias or a sentence and yields no edge at all.
 */
function readEdges(source: string): Edge[] {
  const edges: Edge[] = []

  /** `{ a, b as c }`, `Foo`, `* as ns`, `type { T }`, `` — and nothing else. */
  const CLAUSE = /^(?:type\s[\s\S]*|[\w$*,{}\s]*)$/

  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const before = source.slice(0, match.index)
    const keyword = Math.max(before.lastIndexOf('import'), before.lastIndexOf('export'))
    if (keyword === -1) continue

    const clause = before.slice(keyword).replace(/^(?:import|export)\b/, '')
    if (!CLAUSE.test(clause.trim() === '' ? '' : clause)) continue

    edges.push({ specifier: match[1]!, typeOnly: /^type[\s{]/.test(clause.trim()) })
  }

  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(sideEffect)) {
    edges.push({ specifier: match[1]!, typeOnly: false })
  }

  return edges
}

/** `'../../lib/format.ts'` from a known file → an absolute path, or null if not relative. */
function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) return null
  return resolve(dirname(fromFile), specifier)
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return listFiles(full)
    // The test itself imports `node:fs` and is not shipped. Excluded by name rather than by
    // directory so a second test file here is excluded too, without anybody remembering to.
    if (/\.test\.tsx?$/.test(full)) return []
    return /\.tsx?$/.test(full) ? [full] : []
  })
}

/**
 * Every module reachable from `(preview)/` at runtime, transitively.
 *
 * Only relative edges are followed — a package can be judged from its name, and following
 * `@mini-crux/analysis` into its own sources would turn this into a test of that package.
 */
function reachableModules(): string[] {
  const seen = new Set<string>()
  const queue = listFiles(PREVIEW_ROOT)

  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)

    for (const edge of readEdges(readFileSync(file, 'utf8'))) {
      if (edge.typeOnly) continue
      const target = resolveRelative(edge.specifier, file)
      if (target !== null) queue.push(target)
    }
  }

  return [...seen].sort()
}

describe('preview isolation', () => {
  const modules = reachableModules()

  it('reaches the views, the components and the fixtures', () => {
    // A walk that resolved nothing would pass every assertion below. Pin a few modules that
    // must be in the graph so an empty or broken crawl fails loudly instead of silently.
    const rel = modules.map((m) => relative(SRC_ROOT, m))
    expect(rel).toContain('views/creativos.tsx')
    expect(rel).toContain('views/watchlist-forms.tsx')
    expect(rel).toContain('components/ingestion-health-card.tsx')
    expect(rel).toContain('lib/format.ts')
    expect(rel.length).toBeGreaterThan(20)
  })

  it.each(FORBIDDEN)('imports nothing that reaches $why', (rule) => {
    const offences = modules.flatMap((file) =>
      readEdges(readFileSync(file, 'utf8'))
        .filter((edge) => !edge.typeOnly && rule.test(edge.specifier, file))
        .map((edge) => `${relative(SRC_ROOT, file)} → ${edge.specifier}`),
    )

    expect(offences).toEqual([])
  })

  it('allows @mini-crux/analysis through, and it is genuinely used', () => {
    // Stated as a positive assertion rather than left as a hole in the list above. If the
    // analysis package ever grows an I/O dependency, this is the line that should be revisited
    // — and it will be read, because it names the exemption.
    const users = modules.filter((file) =>
      readEdges(readFileSync(file, 'utf8')).some(
        (edge) => !edge.typeOnly && edge.specifier === '@mini-crux/analysis',
      ),
    )

    // `lib/analysis-copy.ts` needs the gate ids and the feature vocabulary to render a
    // refusal; `views/analisis.tsx` needs `ANALYSIS_FEATURES` to render the "sin medir" cards.
    // Both are strings and arithmetic. A third entry appearing here is worth a second look.
    expect(users.map((m) => relative(SRC_ROOT, m))).toEqual([
      'lib/analysis-copy.ts',
      'views/analisis.tsx',
    ])
  })
})

/**
 * The catalogue and the routes have to agree in both directions.
 *
 * A surface with no catalogue entry is a surface nobody opens during the review, which is the
 * same as not having built it. A catalogue entry with no route is a dead link in the middle of
 * one, which costs the reviewer more than the entry was worth.
 */
describe('preview catalogue', () => {
  const pageFiles = listFiles(join(PREVIEW_ROOT, 'ux'))
    .filter((f) => /[/\\]page\.tsx$/.test(f))
    .map((f) => relative(join(PREVIEW_ROOT, 'ux'), dirname(f)).replaceAll('\\', '/'))
    // `''` is the index at `/ux`, which lists the others rather than being listed.
    .filter((d) => d !== '')

  it.each(PREVIEW_SURFACES.map((s) => [s.path, s] as const))('%s has a route', (_path, surface) => {
    const segments = surface.path.replace(/^\/ux\/?/, '').split('/')
    const matched = pageFiles.some((dir) => {
      const dirSegments = dir.split('/')
      if (dirSegments.length !== segments.length) return false
      // A `[id]` directory matches whatever the catalogue put in that position.
      return dirSegments.every((d, i) => d === segments[i] || /^\[.+\]$/.test(d))
    })
    expect(matched, `no page.tsx under (preview)/ux for ${surface.path}`).toBe(true)
  })

  it('lists every surface that exists', () => {
    const listed = PREVIEW_SURFACES.map((s) => s.path.replace(/^\/ux\/?/, '').split('/').length)
    // Compared by count and by first segment: the id in `/ux/creativos/<uuid>` is a fixture
    // value, not a route segment, so an exact string comparison would be comparing the wrong
    // thing in exactly one case.
    const listedRoots = new Set(
      PREVIEW_SURFACES.map((s) => s.path.replace(/^\/ux\/?/, '').split('/').join('/')),
    )
    expect(listed.length).toBe(pageFiles.length)

    for (const dir of pageFiles) {
      const isDynamic = dir.includes('[')
      const found = [...listedRoots].some((p) =>
        isDynamic
          ? p.startsWith(`${dir.split('/').slice(0, -1).join('/')}/`)
          : p === dir,
      )
      expect(found, `${dir} renders a surface the catalogue does not list`).toBe(true)
    }
  })
})

/**
 * The second line, tested because an untested fallback is a fallback nobody knows the state of.
 *
 * The gate is asserted through {@link isPreviewEnabled} rather than by rendering the layout,
 * and that is a limitation worth stating rather than hiding. Vite's `define` replaces
 * `process.env.NODE_ENV` with a literal at transform time, so inside a module under test the
 * production branch is not merely unreached — it is not compiled. `vi.stubEnv` cannot bring it
 * back. Injecting the value is what makes both branches observable at all; the one line that
 * stays uncovered is the layout calling this function, and the import-graph tests above are
 * what make that line a backstop rather than the guarantee.
 */
describe('production gate', () => {
  it.each([
    ['production', false],
    ['development', true],
    ['test', true],
    // An environment nobody set. Failing closed here would 404 the preview on a machine with
    // no `NODE_ENV`, which is most of them; failing open is right because this is the second
    // line and the tree has nothing to leak.
    [undefined, true],
  ])('isPreviewEnabled(%s) === %s', (nodeEnv, expected) => {
    expect(isPreviewEnabled(nodeEnv)).toBe(expected)
  })
})
