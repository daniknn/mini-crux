import { OrganizationSwitcher, UserButton } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'

/**
 * The empty shell. UC-0 deliberately stops here — the crawl clock (ARCHITECTURE.md §3) is
 * what is under time pressure, not the UI. Real surfaces arrive in UC-3 and UC-4.
 */
export default async function HomePage(): Promise<React.ReactElement> {
  const { orgSlug } = await auth()

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Mini Crux</h1>
        <div className="flex items-center gap-3">
          <OrganizationSwitcher
            hidePersonal
            appearance={{ elements: { rootBox: 'h-11', organizationSwitcherTrigger: 'h-11' } }}
          />
          <UserButton />
        </div>
      </header>

      <section className="rounded-lg border border-border bg-card p-6 shadow-soft">
        <h2 className="font-display text-xl">
          {orgSlug === null || orgSlug === undefined
            ? 'Selecciona un espacio de trabajo'
            : `Espacio de trabajo: ${orgSlug}`}
        </h2>
        <p className="mt-2 text-muted-foreground">
          Aún no hay datos. El rastreo diario del Ad Library empieza en UC-1; los primeros
          resultados de supervivencia necesitan alrededor de ocho semanas de observaciones.
        </p>
      </section>
    </main>
  )
}
