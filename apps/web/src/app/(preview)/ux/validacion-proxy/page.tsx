import { ProxyValidationView } from '../../../../views/validacion-proxy.tsx'
import { PROXY_VALIDATION, PROXY_VALIDATION_NULL } from '../fixtures/proxy-validation.ts'

/**
 * `/ux/validacion-proxy` — UC-7's report, in its three states.
 *
 * Worth reviewing beside `/ux/analisis` rather than as a section of it: this page answers a
 * different question over a different corpus (Spain, quarantined from the MX panel), and a
 * reader who takes its verdict as a statement about the numbers on the analysis page has
 * misread it. Whether the chrome makes that separation obvious is the design question here.
 */
export default async function PreviewProxyValidationPage({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string }>
}): Promise<React.ReactElement> {
  const { caso } = await searchParams

  if (caso === 'sin-corrida') return <ProxyValidationView run={null} />
  return <ProxyValidationView run={caso === 'nulo' ? PROXY_VALIDATION_NULL : PROXY_VALIDATION} />
}
