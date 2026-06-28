// Minimal JSON Schema validator covering the subset used by schema.json:
// type, required, properties, additionalProperties, enum, items,
// minimum, maximum, minLength. Zero dependencies, deterministic error strings.
//
// This exists so the runtime validates against schema.json itself — editing the
// schema asset really does change the output contract, with no hand-rolled
// duplicate validator to drift.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(expected, actual) {
  if (expected === actual) return true;
  // JSON Schema: integers are valid numbers.
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function label(path) {
  return path || "result";
}

function validateNode(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type && !matchesType(schema.type, typeOf(value))) {
    errors.push(`${label(path)} must be of type ${schema.type} (got ${typeOf(value)})`);
    return; // Type mismatch makes further keyword checks meaningless.
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${label(path)} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")} (got ${JSON.stringify(value)})`);
  }

  if (typeof value === "string" && Number.isInteger(schema.minLength) && value.length < schema.minLength) {
    errors.push(`${label(path)} must be a non-empty string`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${label(path)} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${label(path)} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateNode(schema.items, item, `${path}[${i}]`, errors));
  }

  if (typeOf(value) === "object" && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path ? `${path}.` : ""}${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`additional property not allowed: ${path ? `${path}.` : ""}${key}`);
        }
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        validateNode(propSchema, value[key], path ? `${path}.${key}` : key, errors);
      }
    }
  }
}

// Validate `value` against `schema`; returns an array of error strings (empty = valid).
export function validateAgainstSchema(schema, value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["result is not an object"];
  }
  validateNode(schema, value, "", errors);
  return errors;
}

// Strip metadata and constraint keywords that provider structured-output modes
// reject (OpenAI strict json_schema, Gemini responseSchema). Structural keywords
// (type/properties/required/additionalProperties/enum/items) are preserved; the
// stripped constraints are still enforced locally by validateAgainstSchema.
export function sanitizeSchemaForProvider(schema, { keepConstraints = false, extraDrop = [] } = {}) {
  // corroborated_by is a merge-time annotation, never produced by a provider.
  // Always strip it from the provider-facing schema: leaving an optional property
  // in an additionalProperties:false object breaks OpenAI strict json_schema
  // (which requires every property be in `required`).
  const ALWAYS_DROP = ["$schema", "$comment", "corroborated_by"];
  const DROP = keepConstraints
    ? new Set([...ALWAYS_DROP, ...extraDrop])
    : new Set([...ALWAYS_DROP, "minLength", "minimum", "maximum", ...extraDrop]);

  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      if (DROP.has(key)) continue;
      out[key] = walk(val);
    }
    return out;
  }
  return walk(schema);
}
