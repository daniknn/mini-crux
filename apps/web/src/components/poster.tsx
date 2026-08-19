import { cn } from '../lib/utils.ts'

/**
 * A creative's poster frame, or the text card that stands in for one.
 *
 * This component exists for the same reason `Duration` does: so that no surface renders the
 * image on its own. There are three states a caller would otherwise have to remember —
 * a poster, a poster we could not measure, and a poster whose bytes are missing — and the
 * failure mode of forgetting is an `<img>` pointed at `null`, which browsers render as a
 * broken-image glyph. A text card is a deliberate absence; a broken glyph is a bug the page
 * is asserting is fine.
 *
 * The alt text is not decorative and is not `""`. The gallery is a wall of near-identical
 * rectangles, so a screen-reader user navigating it gets nothing from the images themselves;
 * naming the advertiser is what makes the card identifiable at all (UC-4 rule 6, WCAG AA).
 */
export function Poster({
  src,
  advertiserName,
  mediaType,
  className,
}: {
  src: string | null
  advertiserName: string
  mediaType: string
  className?: string
}): React.ReactElement {
  const frame = cn(
    'relative flex aspect-[4/5] w-full items-center justify-center overflow-hidden rounded-lg bg-sunken',
    className,
  )

  if (src === null) {
    return (
      <div className={frame}>
        {/* Not an image element with no source: aria-hidden decoration plus a visible label,
            so assistive tech is told the poster is absent rather than left to announce a
            broken graphic. */}
        <span className="px-3 text-center text-xs text-muted-foreground">Sin miniatura</span>
      </div>
    )
  }

  return (
    <div className={frame}>
      {/* Plain <img>, not next/image: the src is a short-lived signed URL on the Supabase
          origin, so Next's optimizer would either need that origin whitelisted as a remote
          pattern or would cache a URL that expires in ten minutes and then serve a 400 from
          its own cache. The posters are already downscaled to 640px by the extractor, which
          is the resizing next/image would have been doing. Disable approved explicitly
          (DashOne §1 requires a human OK for any lint suppression). */}
      {/* eslint-disable-next-line @next/next/no-img-element -- reason: signed URL rotates per render; poster already downscaled to 640px by the extractor */}
      <img
        src={src}
        alt={`Miniatura del creativo de ${advertiserName} (${mediaType})`}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    </div>
  )
}
