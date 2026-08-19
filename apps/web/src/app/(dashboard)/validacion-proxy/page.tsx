import { getLatestProxyValidation } from '@mini-crux/db/dashboard'

import { withWorkspace } from '../../../server/db.ts'
import { ProxyValidationView } from '../../../views/validacion-proxy.tsx'

/**
 * The validation report's data — one read, and nothing computed. Everything it renders lives
 * in {@link ProxyValidationView}; see `specs/UC-10-ux-preview.md` for why the seam is here.
 */
export default async function ProxyValidationPage(): Promise<React.ReactElement> {
  const run = await withWorkspace((db) => getLatestProxyValidation(db))

  return <ProxyValidationView run={run} />
}
