export class ParserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ParserError";
    this.code = code;
  }
}
