/**
 * Runtime schema validation engine with Zod-compatible fluent API.
 * Executes deterministically in Cloudflare Workers, Browser, and Node.js
 * without eval() or new Function().
 */

export type ValidationIssue = {
  path: string;
  message: string;
};

export type SafeParseSuccess<T> = {
  success: true;
  data: T;
};

export type SafeParseError = {
  success: false;
  issues: ValidationIssue[];
  fieldErrors: Record<string, string[]>;
};

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError;

export class SchemaValidationError extends Error {
  public readonly issues: ValidationIssue[];
  public readonly fieldErrors: Record<string, string[]>;

  constructor(issues: ValidationIssue[]) {
    super("One or more fields failed validation.");
    this.name = "SchemaValidationError";
    this.issues = issues;
    const grouped: Record<string, string[]> = {};
    for (const issue of issues) {
      const key = issue.path || "_root";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(issue.message);
    }
    this.fieldErrors = grouped;
  }
}

export abstract class SchemaType<TOutput> {
  abstract _parse(input: unknown, path: string): ValidationIssue[] | { ok: true; value: TOutput };

  safeParse(input: unknown): SafeParseResult<TOutput> {
    const res = this._parse(input, "");
    if (Array.isArray(res)) {
      const grouped: Record<string, string[]> = {};
      for (const issue of res) {
        const key = issue.path || "_root";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(issue.message);
      }
      return { success: false, issues: res, fieldErrors: grouped };
    }
    return { success: true, data: res.value };
  }

  parse(input: unknown): TOutput {
    const result = this.safeParse(input);
    if (!result.success) {
      throw new SchemaValidationError(result.issues);
    }
    return result.data;
  }

  optional(): SchemaType<TOutput | undefined> {
    const self = this;
    return new CustomSchema<TOutput | undefined>((input, path) => {
      if (input === undefined) return { ok: true, value: undefined };
      return self._parse(input, path);
    });
  }

  nullable(): SchemaType<TOutput | null> {
    const self = this;
    return new CustomSchema<TOutput | null>((input, path) => {
      if (input === null) return { ok: true, value: null };
      return self._parse(input, path);
    });
  }

  default(defaultValue: TOutput): SchemaType<TOutput> {
    const self = this;
    return new CustomSchema<TOutput>((input, path) => {
      if (input === undefined) return { ok: true, value: defaultValue };
      return self._parse(input, path);
    });
  }

  refine(predicate: (val: TOutput) => boolean, message: string): SchemaType<TOutput> {
    const self = this;
    return new CustomSchema<TOutput>((input, path) => {
      const base = self._parse(input, path);
      if (Array.isArray(base)) return base;
      if (!predicate(base.value)) {
        return [{ path, message }];
      }
      return base;
    });
  }
}

export class CustomSchema<T> extends SchemaType<T> {
  private readonly fn: (input: unknown, path: string) => ValidationIssue[] | { ok: true; value: T };

  constructor(fn: (input: unknown, path: string) => ValidationIssue[] | { ok: true; value: T }) {
    super();
    this.fn = fn;
  }

  _parse(input: unknown, path: string): ValidationIssue[] | { ok: true; value: T } {
    return this.fn(input, path);
  }
}

export class StringSchema extends SchemaType<string> {
  private minLen?: { val: number; msg: string };
  private maxLen?: { val: number; msg: string };
  private regexRule?: { re: RegExp; msg: string };
  private shouldTrim = false;
  private shouldLower = false;

  trim(): this {
    this.shouldTrim = true;
    return this;
  }

  toLowerCase(): this {
    this.shouldLower = true;
    return this;
  }

  min(len: number, message = `Must be at least ${len} characters.`): this {
    this.minLen = { val: len, msg: message };
    return this;
  }

  max(len: number, message = `Must be at most ${len} characters.`): this {
    this.maxLen = { val: len, msg: message };
    return this;
  }

  regex(re: RegExp, message = "Invalid format."): this {
    this.regexRule = { re, msg: message };
    return this;
  }

  email(message = "Enter a valid email address."): this {
    return this.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, message);
  }

  uuid(message = "Must be a valid UUID."): this {
    return this.regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      message
    );
  }

  url(message = "Enter a valid URL."): this {
    return this.refine((val) => {
      try {
        const parsed = new URL(val);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, message) as unknown as this;
  }

  _parse(input: unknown, path: string): ValidationIssue[] | { ok: true; value: string } {
    if (typeof input !== "string") {
      return [{ path, message: "Expected a string." }];
    }
    let val = this.shouldTrim ? input.trim() : input;
    if (this.shouldLower) val = val.toLowerCase();
    // Reject ASCII control characters (except tab/newline)
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(val)) {
      return [{ path, message: "String contains disallowed control characters." }];
    }
    if (this.minLen && val.length < this.minLen.val) {
      return [{ path, message: this.minLen.msg }];
    }
    if (this.maxLen && val.length > this.maxLen.val) {
      return [{ path, message: this.maxLen.msg }];
    }
    if (this.regexRule && !this.regexRule.re.test(val)) {
      return [{ path, message: this.regexRule.msg }];
    }
    return { ok: true, value: val };
  }
}

export class NumberSchema extends SchemaType<number> {
  private isInt = false;
  private minVal?: { val: number; msg: string };
  private maxVal?: { val: number; msg: string };

  int(message = "Expected an integer."): this {
    this.isInt = true;
    return this;
  }

  min(val: number, message = `Must be at least ${val}.`): this {
    this.minVal = { val, msg: message };
    return this;
  }

  max(val: number, message = `Must be at most ${val}.`): this {
    this.maxVal = { val, msg: message };
    return this;
  }

  nonnegative(message = "Must be zero or positive."): this {
    return this.min(0, message);
  }

  positive(message = "Must be greater than zero."): this {
    return this.min(1, message);
  }

  _parse(input: unknown, path: string): ValidationIssue[] | { ok: true; value: number } {
    if (typeof input !== "number" || !Number.isFinite(input)) {
      return [{ path, message: "Expected a finite number." }];
    }
    if (this.isInt && !Number.isSafeInteger(input)) {
      return [{ path, message: "Expected a safe integer." }];
    }
    if (this.minVal !== undefined && input < this.minVal.val) {
      return [{ path, message: this.minVal.msg }];
    }
    if (this.maxVal !== undefined && input > this.maxVal.val) {
      return [{ path, message: this.maxVal.msg }];
    }
    return { ok: true, value: input };
  }
}

export type Infer<T extends SchemaType<unknown>> = T extends SchemaType<infer O> ? O : never;

export const v = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () =>
    new CustomSchema<boolean>((input, path) =>
      typeof input === "boolean" ? { ok: true, value: input } : [{ path, message: "Expected a boolean." }]
    ),
  literal: <T extends string | number | boolean>(expected: T) =>
    new CustomSchema<T>((input, path) =>
      input === expected
        ? { ok: true, value: expected }
        : [{ path, message: `Expected literal ${String(expected)}.` }]
    ),
  enum: <T extends readonly [string, ...string[]]>(values: T) =>
    new CustomSchema<T[number]>((input, path) =>
      typeof input === "string" && (values as readonly string[]).includes(input)
        ? { ok: true, value: input as T[number] }
        : [{ path, message: `Expected one of: ${values.join(", ")}.` }]
    ),
  array: <T>(itemSchema: SchemaType<T>, opts?: { min?: number; max?: number }) =>
    new CustomSchema<T[]>((input, path) => {
      if (!Array.isArray(input)) {
        return [{ path, message: "Expected an array." }];
      }
      if (opts?.min !== undefined && input.length < opts.min) {
        return [{ path, message: `Array must contain at least ${opts.min} item(s).` }];
      }
      if (opts?.max !== undefined && input.length > opts.max) {
        return [{ path, message: `Array must contain at most ${opts.max} item(s).` }];
      }
      const out: T[] = [];
      const issues: ValidationIssue[] = [];
      for (let i = 0; i < input.length; i++) {
        const subPath = path ? `${path}.${i}` : String(i);
        const res = itemSchema._parse(input[i], subPath);
        if (Array.isArray(res)) {
          issues.push(...res);
        } else {
          out.push(res.value);
        }
      }
      return issues.length > 0 ? issues : { ok: true, value: out };
    }),
  record: <T>(valueSchema: SchemaType<T>) =>
    new CustomSchema<Record<string, T>>((input, path) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return [{ path, message: "Expected an object map." }];
      }
      const out: Record<string, T> = {};
      const issues: ValidationIssue[] = [];
      for (const [k, val] of Object.entries(input as Record<string, unknown>)) {
        const subPath = path ? `${path}.${k}` : k;
        const res = valueSchema._parse(val, subPath);
        if (Array.isArray(res)) {
          issues.push(...res);
        } else {
          out[k] = res.value;
        }
      }
      return issues.length > 0 ? issues : { ok: true, value: out };
    }),
  object: <TShape extends Record<string, SchemaType<unknown>>>(
    shape: TShape,
    options?: { allowUnknown?: boolean }
  ) =>
    new CustomSchema<{ [K in keyof TShape]: Infer<TShape[K]> }>((input, path) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return [{ path, message: "Expected a JSON object." }];
      }
      const raw = input as Record<string, unknown>;
      const issues: ValidationIssue[] = [];
      const out: Record<string, unknown> = {};

      if (!options?.allowUnknown) {
        const allowedKeys = new Set(Object.keys(shape));
        for (const key of Object.keys(raw)) {
          if (!allowedKeys.has(key)) {
            const subPath = path ? `${path}.${key}` : key;
            issues.push({ path: subPath, message: `Unknown field '${key}' is not permitted.` });
          }
        }
      }

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const subPath = path ? `${path}.${key}` : key;
        const res = fieldSchema._parse(raw[key], subPath);
        if (Array.isArray(res)) {
          issues.push(...res);
        } else if (res.value !== undefined) {
          out[key] = res.value;
        }
      }

      return issues.length > 0
        ? issues
        : { ok: true, value: out as { [K in keyof TShape]: Infer<TShape[K]> } };
    }),
  unknown: () => new CustomSchema<unknown>((input) => ({ ok: true, value: input })),
};
