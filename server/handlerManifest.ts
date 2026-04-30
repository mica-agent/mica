/**
 * Handler manifest registry — the discovery surface for channel handlers.
 *
 * Each channel handler can ship a manifest alongside its factory. The
 * manifest documents the handler's args, the message shapes the card sends
 * and receives, and when an authoring agent should pick it. The registry
 * is exposed at `GET /api/handlers` so authoring agents can discover
 * available handlers at the moment they need to write a card class —
 * keeping skill prose flat as plugin count grows.
 *
 * Handlers without a manifest are still valid (legacy plugins, internal-
 * only handlers); they just don't appear in the discovery surface.
 */

// Minimal JSON Schema subset we actually use. argsSchema is consumed by
// our tiny boundary validator; sendShapes / recvShapes are documentation
// for authoring agents (NOT validated server-side — the card decides what
// to send and the handler decides what to broadcast). Keeping this loose
// avoids an AJV dep for a payload set that fits in a few primitives.
export interface JSONSchemaLike {
  type?: "object" | "string" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JSONSchemaLike>;
  required?: string[];
  items?: JSONSchemaLike;
  enum?: unknown[];
  default?: unknown;
  oneOf?: JSONSchemaLike[];
}

export interface HandlerManifest {
  /** Stable lookup key — matches the value of `metadata.handler` in card classes. */
  name: string;
  /** One-line summary, surfaced in handler list views. */
  description: string;
  /** Decision rule for an authoring agent — when this handler is the right pick. */
  whenToUse: string;
  /** Schema for the args object passed to `mica.openChannel(fn, args)`. Validated at session-open. */
  argsSchema: JSONSchemaLike;
  /** Documents the shapes the card may pass to `channel.send(...)`. Reference-only. */
  sendShapes: JSONSchemaLike;
  /** Documents the shapes the card receives via `channel.onData(...)`. Reference-only. */
  recvShapes: JSONSchemaLike;
  /** Optional copy-pasteable card.js skeleton. */
  examples?: string;
  /** Semver of the handler contract. Cards built against v1 can detect drift to v2. */
  version: string;
}

const manifests = new Map<string, HandlerManifest>();

export function registerManifest(manifest: HandlerManifest): void {
  if (manifests.has(manifest.name)) {
    console.warn(`[manifest] Re-registering "${manifest.name}" — last-write-wins.`);
  }
  manifests.set(manifest.name, manifest);
}

export function getManifest(name: string): HandlerManifest | undefined {
  return manifests.get(name);
}

export function getManifests(): HandlerManifest[] {
  return Array.from(manifests.values());
}

export function getManifestNames(): string[] {
  return Array.from(manifests.keys());
}

/** Validate args against a manifest's argsSchema. Returns null on success,
 *  or a structured error pointing at the failing path. The card surfaces
 *  this so authoring agents see the schema mismatch immediately rather
 *  than debugging the handler's downstream nullref. */
export function validateArgs(
  manifest: HandlerManifest,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  return validateAgainstSchema(args, manifest.argsSchema, "args");
}

function validateAgainstSchema(
  value: unknown,
  schema: JSONSchemaLike,
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (!schema.type) return { ok: true };  // permissive when type unspecified

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `${path}: expected object, got ${describe(value)}` };
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) {
        return { ok: false, error: `${path}.${req}: required` };
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        const r = validateAgainstSchema(obj[key], propSchema, `${path}.${key}`);
        if (!r.ok) return r;
      }
    }
    return { ok: true };
  }

  if (schema.type === "string") {
    if (typeof value !== "string") return { ok: false, error: `${path}: expected string, got ${describe(value)}` };
    if (schema.enum && !schema.enum.includes(value)) {
      return { ok: false, error: `${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}` };
    }
    return { ok: true };
  }

  if (schema.type === "number") {
    if (typeof value !== "number") return { ok: false, error: `${path}: expected number, got ${describe(value)}` };
    return { ok: true };
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, error: `${path}: expected boolean, got ${describe(value)}` };
    return { ok: true };
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return { ok: false, error: `${path}: expected array, got ${describe(value)}` };
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const r = validateAgainstSchema(value[i], schema.items, `${path}[${i}]`);
        if (!r.ok) return r;
      }
    }
    return { ok: true };
  }

  return { ok: true };
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
