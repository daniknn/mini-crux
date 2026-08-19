/**
 * Every surface the preview renders, and every state of it worth arguing about.
 *
 * This list is data rather than markup because two very different readers need it. The index
 * page renders it, so a reviewer can reach a state without knowing the query string. And
 * `preview-isolation.test.ts` walks it, so a surface added to `(preview)/` without a catalogue
 * entry — or an entry pointing at a route that does not exist — fails the suite instead of
 * quietly dropping out of the design review. A review is only as complete as the list of
 * things it looked at, and an unlisted state is one nobody looked at.
 *
 * States are `?caso=` search params, not path segments. `/ux/creativos/[id]` already owns the
 * child slot under `/ux/creativos`, and a static `/ux/creativos/vacio` beside a dynamic
 * sibling resolves correctly but only if you know Next's precedence rules — a search param
 * costs nothing and asks nobody to know them (`specs/UC-10-ux-preview.md` §5).
 */

/** The creative `/ux/creativos/[id]` renders. Matches `CREATIVE_DETAIL` in the fixtures. */
export const PREVIEW_CREATIVE_ID = '3f7a1c92-5b64-4a10-9d2e-8c4f6b0a7e31'

export interface PreviewCase {
  /**
   * The `?caso=` value, or `undefined` for the state the route renders with no params —
   * which is always the populated, everything-present one.
   */
  caso?: string
  /** Shown on the index. Mexican Spanish, like everything a reader sees. */
  label: string
  /** Why this state is worth a look, rather than what it contains. */
  note: string
}

export interface PreviewSurface {
  /** Absolute, including the `/ux` prefix — this is what a reviewer clicks. */
  path: string
  title: string
  summary: string
  cases: PreviewCase[]
}

export const PREVIEW_SURFACES: readonly PreviewSurface[] = [
  {
    path: '/ux/novedades',
    title: 'Novedades',
    summary: '¿Qué cambió esta semana? Lanzados, descubiertos y retirados, en secciones aparte.',
    cases: [
      {
        label: 'Con movimientos',
        note: 'Las tres secciones con contenido, incluida una fecha de inicio ausente.',
      },
      {
        caso: 'sin-movimientos',
        label: 'Semana quieta',
        note: 'Hay panel, pero nadie lanzó ni retiró nada. No es lo mismo que no haber mirado.',
      },
      {
        caso: 'sin-rastreos',
        label: 'Panel sin rastreos',
        note: 'El estado del primer día: todavía no hay ni una corrida que leer.',
      },
    ],
  },
  {
    path: '/ux/creativos',
    title: 'Creativos',
    summary: 'La galería, ordenada por supervivencia. Filtros de anunciante, estado y orden.',
    cases: [
      {
        label: 'Con creativos',
        note: 'Mezcla a propósito: uno censurado, uno con huecos de observación y uno sin póster.',
      },
      {
        caso: 'vacio',
        label: 'Sin resultados',
        note: 'Filtros que no coinciden con nada, con panel lleno detrás.',
      },
    ],
  },
  {
    path: `/ux/creativos/${PREVIEW_CREATIVE_ID}`,
    title: 'Creativo — detalle',
    summary: 'Un creativo con sus medidas, su transcripción y su historial de observación.',
    cases: [
      {
        label: 'Medido completo',
        note: 'Todas las medidas presentes, varios ad_archive_ids y un tramo recortado.',
      },
      {
        caso: 'escaso',
        label: 'Sin extraer',
        note: 'Lo que se ve cuando el extractor todavía no pasó: medidas nulas con su motivo.',
      },
    ],
  },
  {
    path: '/ux/estructura',
    title: 'Estructura',
    summary: 'Cómo arma sus creativos un anunciante, contra la mediana del panel.',
    cases: [
      {
        label: 'Perfil contra panel',
        note: 'Cuatro métricas con sus cuartiles y su n, más el gancho de texto.',
      },
      {
        caso: 'un-anunciante',
        label: 'Muestra chica',
        note: 'n por debajo de 5: aquí es donde tiene que aparecer la advertencia de muestra.',
      },
      {
        caso: 'vacio',
        label: 'Sin anunciantes',
        note: 'Panel sin un solo anunciante todavía.',
      },
    ],
  },
  {
    path: '/ux/analisis',
    title: 'Análisis',
    summary: 'El contraste entre creativos longevos y efímeros, con sus caveats en la tarjeta.',
    cases: [
      {
        label: 'Con hallazgo',
        note: 'Una diferencia que pasó los umbrales, más las que no, más los conteos por etiqueta.',
      },
      {
        caso: 'rechazado',
        label: 'Rechazado por umbral',
        note: 'El panel no alcanzó: la pantalla dice qué faltó, no muestra números a medias.',
      },
      {
        caso: 'sin-corrida',
        label: 'Sin corridas',
        note: 'Nunca corrió el análisis.',
      },
    ],
  },
  {
    path: '/ux/validacion-proxy',
    title: 'Validación',
    summary: '¿Los días activos siguen al esfuerzo del anunciante? El contraste de España (UC-7).',
    cases: [
      {
        label: 'Con veredicto',
        note: 'β con su intervalo, el estimado ingenuo al lado como exhibición, no como titular.',
      },
      {
        caso: 'nulo',
        label: 'Sin señal',
        note: 'El intervalo cruza 1: el veredicto tiene que leerse como "no concluye".',
      },
      {
        caso: 'sin-corrida',
        label: 'Sin corridas',
        note: 'Esta validación se dispara a mano, así que este estado es el normal al principio.',
      },
    ],
  },
  {
    path: '/ux/listas',
    title: 'Listas',
    summary: 'Lo que el rastreador revisa cada día, y si sigue mirando. Formularios incluidos.',
    cases: [
      {
        label: 'Activas y pausadas',
        note: 'Con corridas fallidas y dudosas contadas aparte, y el estado de ingesta arriba.',
      },
      {
        caso: 'vacio',
        label: 'Sin listas',
        note: 'La cuenta recién creada: sólo el formulario y el vacío explicado.',
      },
    ],
  },
]

/** `/ux/creativos` + `sin-movimientos` → `/ux/creativos?caso=sin-movimientos`. */
export function caseHref(surface: PreviewSurface, entry: PreviewCase): string {
  return entry.caso === undefined ? surface.path : `${surface.path}?caso=${entry.caso}`
}
