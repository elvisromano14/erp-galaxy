export class Paged<T> {
  constructor(public readonly data: T[], public readonly meta: { page: number; limit: number; total: number; totalPages: number }) {}
  static of<T>(data: T[], total: number, page: number, limit: number) {
    return new Paged(data, { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  }
}

/** Paginación por cursor (kardex, movimientos). */
export class CursorPage<T> {
  constructor(public readonly data: T[], public readonly meta: { limit: number; nextCursor: string | null }) {}
}
