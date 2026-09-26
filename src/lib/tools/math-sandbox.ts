/**
 * Deterministic Math & Scientific Formula Evaluation Sandbox
 * Evaluates mathematical expressions, financial formulas, statistics, and conversions safely.
 */

export interface MathResult {
  success: boolean;
  expression: string;
  result?: number | string | boolean | object;
  formatted?: string;
  error?: string;
}

const SAFE_MATH_CONTEXT: Record<string, any> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  round: Math.round,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  trunc: Math.trunc,
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
};

export function evaluateMathExpression(expression: string): MathResult {
  const expr = (expression || "").trim();
  if (!expr) {
    return { success: false, expression: expr, error: "Mathematical expression must not be empty." };
  }

  // Reject malicious tokens / access to global objects
  if (
    /process|window|document|global|constructor|prototype|fetch|import|require|localStorage|indexedDB|sessionStorage|cookie|eval|Function|setTimeout|setInterval/i.test(
      expr
    )
  ) {
    return { success: false, expression: expr, error: "Forbidden token detected in mathematical expression." };
  }

  try {
    // Sanitize and replace standard scientific functions into JS Math functions
    const sanitized = expr
      .replace(/\^/g, "**")
      .replace(/\bpi\b/gi, "Math.PI")
      .replace(/\be\b/g, "Math.E")
      .replace(/\bsin\(/g, "Math.sin(")
      .replace(/\bcos\(/g, "Math.cos(")
      .replace(/\btan\(/g, "Math.tan(")
      .replace(/\bsqrt\(/g, "Math.sqrt(")
      .replace(/\blog\(/g, "Math.log10(")
      .replace(/\bln\(/g, "Math.log(")
      .replace(/\babs\(/g, "Math.abs(")
      .replace(/\bceil\(/g, "Math.ceil(")
      .replace(/\bfloor\(/g, "Math.floor(")
      .replace(/\bround\(/g, "Math.round(");

    // Evaluate in safe isolated function scope
    const fn = new Function("Math", `return (${sanitized});`);
    const rawResult = fn(Math);

    if (rawResult === undefined || (typeof rawResult === "number" && isNaN(rawResult))) {
      return { success: false, expression: expr, error: "Expression evaluated to NaN or undefined." };
    }

    let formatted = String(rawResult);
    if (typeof rawResult === "number" && !Number.isInteger(rawResult)) {
      formatted = String(Number(rawResult.toFixed(8)));
    }

    return {
      success: true,
      expression: expr,
      result: rawResult,
      formatted,
    };
  } catch (err: any) {
    return {
      success: false,
      expression: expr,
      error: `Math evaluation error: ${err?.message || String(err)}`,
    };
  }
}
