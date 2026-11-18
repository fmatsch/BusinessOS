export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} nicht gefunden`);
    this.name = "NotFoundError";
  }
}

/** Zustand lässt die Operation nicht zu (z. B. bereits entschieden, bereits bestellt). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
