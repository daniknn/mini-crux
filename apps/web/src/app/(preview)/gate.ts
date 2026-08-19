/**
 * Whether the `/ux` design preview may render.
 *
 * A one-line rule in its own module, and the environment arrives as a **parameter** with a
 * default rather than being read inside. Ambient state read in place can only ever be observed
 * at whatever value the suite happens to run under — here that is always `'test'`, so a gate
 * written as a bare `process.env.NODE_ENV === 'production'` check inside the layout has
 * exactly one reachable branch and its `true` case is decoration (`CLAUDE.md`: *a default taken
 * from `now()` is only observable at whatever o'clock the suite runs*). Injected, both branches
 * are one assertion each.
 *
 * This is the *second* line of defence and it is worth being clear about the order. The first
 * is that nothing under `(preview)/` imports the server, Clerk, `@mini-crux/db` or Supabase, so
 * the tree has no credential to leak even with this function deleted —
 * `preview-isolation.test.ts` is what holds that. A gate is a good backstop and a bad only
 * plan, because it fails open the moment someone renames an environment.
 */
export function isPreviewEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'production'
}
