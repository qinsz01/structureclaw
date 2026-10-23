/** A rejected engineering input, distinct from infrastructure and programming failures. */
export class EngineeringValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineeringValidationError';
  }
}
