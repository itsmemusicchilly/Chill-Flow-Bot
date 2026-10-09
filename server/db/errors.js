/** Thrown when a page address is already used by another page in the same server. */
export class SlugTakenError extends Error {
  constructor(message) { super(message); this.name = 'SlugTakenError'; }
}
