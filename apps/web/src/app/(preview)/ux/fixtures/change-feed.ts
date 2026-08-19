import type { ChangeFeed, ChangeFeedEntry } from '@mini-crux/db/dashboard'

/**
 * One week of movement, invented.
 *
 * The window is anchored to the panel's own last crawl day (2026-08-18), never to a clock —
 * which is the rule the surface exists to respect, and a fixture dated from `new Date()` would
 * quietly stop demonstrating it the day nobody looked.
 *
 * The three sections are populated with the cases that make them worth separating: something
 * Meta says started this week, something that has been running since last November and only
 * just entered our panel, and something that stopped. The middle one is the whole argument —
 * it is news about our coverage, not about the market.
 */

const LAUNCHED: ChangeFeedEntry[] = [
  {
    kind: 'launched',
    creativeId: '5a1c7d38-2b90-4e64-a1f7-0c9d38e5b724',
    creativeHash: '77b4e2c091ad35f86e0142cb9d7a3f58',
    advertiserId: 'adv-1111',
    advertiserName: 'Bodega Aurora',
    mediaType: 'video',
    eventDate: '2026-08-14',
    startedDate: '2026-08-14',
    firstSeenDate: '2026-08-15',
    stoppedDate: null,
    daysActive: 5,
    isCensored: true,
    observationDays: 4,
    hasGaps: false,
    adCopy: 'Quincena de frutas y verduras. Precios de central de abasto, sin ir hasta allá.',
    firstLineTranscript: 'El kilo de jitomate, a precio de central.',
    posterStoragePath: 'posters/adv-1111/77b4e2c0.jpg',
  },
  {
    kind: 'launched',
    creativeId: 'c30f9b25-84ea-4d17-95b6-1f27a4c8e903',
    creativeHash: '2f9d6a1470bc58e3d2419f087ac3b6e5',
    advertiserId: 'adv-2222',
    advertiserName: 'Seguros Alcatraz',
    mediaType: 'video',
    eventDate: '2026-08-17',
    startedDate: '2026-08-17',
    firstSeenDate: '2026-08-17',
    stoppedDate: null,
    daysActive: 2,
    isCensored: true,
    observationDays: 2,
    hasGaps: false,
    adCopy: 'Cotiza, compara y contrata desde el celular. Cobertura amplia desde $389 al mes.',
    firstLineTranscript: null,
    posterStoragePath: null,
  },
]

const DISCOVERED: ChangeFeedEntry[] = [
  {
    kind: 'discovered',
    creativeId: 'e6420a91-77cd-4b38-8f05-93b1e2d47c60',
    creativeHash: '9c05e3b7218fda64031e8b57c9042daf',
    advertiserId: 'adv-3333',
    advertiserName: 'Café Zócalo',
    mediaType: 'video',
    // We saw it on the 15th. Meta says it has been running since November — nine months
    // before this panel existed. Filing it under "nuevo" would be the same error as using
    // `first_seen_at` for a start date.
    eventDate: '2026-08-15',
    startedDate: '2025-11-03',
    firstSeenDate: '2026-08-15',
    stoppedDate: null,
    daysActive: 289,
    isCensored: true,
    observationDays: 4,
    hasGaps: false,
    adCopy: 'Suscripción de café: un kilo al mes, tostado la semana que llega a tu casa.',
    firstLineTranscript: 'Lo tostamos el lunes. El miércoles ya está en tu cocina.',
    posterStoragePath: 'posters/adv-3333/9c05e3b7.jpg',
  },
  {
    kind: 'discovered',
    creativeId: '1b8e5f42-0a37-4c96-b2d1-6e0947f3a85c',
    creativeHash: 'ba13782ce905f4d6a72c0e83b14f9d20',
    advertiserId: 'adv-1111',
    advertiserName: 'Bodega Aurora',
    mediaType: 'image',
    eventDate: '2026-08-12',
    // No start date from Meta at all, so we cannot even say how long it has been running.
    startedDate: null,
    firstSeenDate: '2026-08-12',
    stoppedDate: null,
    daysActive: 7,
    isCensored: true,
    observationDays: 7,
    hasGaps: false,
    adCopy: 'Martes de pollo. 3x2 en piezas seleccionadas, sólo en tienda.',
    firstLineTranscript: null,
    posterStoragePath: null,
  },
]

const STOPPED: ChangeFeedEntry[] = [
  {
    kind: 'stopped',
    creativeId: '7c2b9e40-1a5d-4f83-b6c1-2d90ef47a5b2',
    creativeHash: 'd4e81b02fa7c6539ae10cb47d2b3f065',
    advertiserId: 'adv-2222',
    advertiserName: 'Seguros Alcatraz',
    mediaType: 'video',
    eventDate: '2026-08-13',
    startedDate: '2026-05-02',
    firstSeenDate: '2026-06-01',
    stoppedDate: '2026-08-13',
    daysActive: 103,
    isCensored: false,
    observationDays: 69,
    hasGaps: true,
    adCopy: 'Tu auto asegurado en 4 minutos, sin llamadas y sin letras chiquitas.',
    firstLineTranscript: null,
    posterStoragePath: 'posters/adv-2222/d4e81b02.jpg',
  },
]

export const CHANGE_FEED: ChangeFeed = {
  since: '2026-08-12',
  until: '2026-08-18',
  launched: LAUNCHED,
  discovered: DISCOVERED,
  stopped: STOPPED,
}

/**
 * A healthy panel where nothing moved.
 *
 * Worth its own state because it is the one an operator will misread: an empty week and a week
 * of failed crawls produce the same screen, and the copy has to say so.
 */
export const CHANGE_FEED_QUIET: ChangeFeed = {
  since: '2026-08-12',
  until: '2026-08-18',
  launched: [],
  discovered: [],
  stopped: [],
}
