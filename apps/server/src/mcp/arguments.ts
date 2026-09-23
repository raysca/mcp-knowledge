import { AppError } from "../../../../packages/core/src/errors.ts";

type IntegerOptions = {
  name: string;
  defaultValue: number;
  min: number;
  max: number;
};

export function boundedInteger(value: unknown, options: IntegerOptions): number {
  if (value === undefined || value === null || value === "") return options.defaultValue;
  if (typeof value === "number" && !Number.isFinite(value)) return options.defaultValue;

  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < options.min ||
    parsed > options.max
  ) {
    throw new AppError(
      "INVALID_TOOL_ARGUMENTS",
      `${options.name} must be an integer from ${options.min} to ${options.max}.`,
      400,
    );
  }

  return parsed;
}
