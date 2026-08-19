import { redirect } from 'next/navigation'

/**
 * The root is not a surface. "What changed?" is the question an operator opens the product
 * with, so the change feed is the landing page and `/` only forwards to it.
 */
export default function HomePage(): never {
  redirect('/novedades')
}
