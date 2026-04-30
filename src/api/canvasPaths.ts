// canvasPaths.ts — shared helpers for translating between project-relative
// paths (the wire/storage format) and canvas-relative paths (what cards
// see and what the UI displays).
//
// The canvas is a card's "current working directory." Paths the card or
// the user sees are canvas-relative; paths in HTTP wire calls and on-disk
// sidecars are project-relative. Translation lives at the boundary —
// CardRuntime for the card-side API, the React shell for UI display.

/** Resolve a card-supplied (canvas-relative) path to a project-relative path
 *  the server expects on the wire. Throws if the resolution escapes the
 *  project root.
 *
 *  Convention (Unix-CWD model with canvas as cwd):
 *    bare name "foo.bar"      → "<canvasRoot>/foo.bar"
 *    sub path  "sub/foo"      → "<canvasRoot>/sub/foo"
 *    escape    "../foo"       → one level above canvas
 *    absolute  "/foo"         → project-root absolute (slash stripped)
 *    too many  "../../../etc" → THROW (escapes project root) */
export function canonicalizeCardPath(rawPath: string, canvasRoot: string): string {
  if (typeof rawPath !== "string" || !rawPath) {
    throw new Error("canonicalizeCardPath: path must be a non-empty string");
  }
  const path = rawPath.replace(/\\/g, "/");
  if (path.startsWith("/")) {
    const stripped = path.slice(1);
    if (stripped.includes("..")) {
      throw new Error(`canonicalizeCardPath: leading-slash path "${rawPath}" cannot also contain ..`);
    }
    return stripped;
  }
  const baseParts = canvasRoot ? canvasRoot.split("/").filter(Boolean) : [];
  const parts = path.split("/");
  const result = [...baseParts];
  for (const p of parts) {
    if (p === "..") {
      if (result.length === 0) {
        throw new Error(`canonicalizeCardPath: path "${rawPath}" escapes the project root`);
      }
      result.pop();
    } else if (p === "." || p === "") {
      // skip
    } else {
      result.push(p);
    }
  }
  if (result.length === 0) {
    throw new Error(`canonicalizeCardPath: path "${rawPath}" resolves to project root with no filename`);
  }
  return result.join("/");
}

/** Inverse of canonicalizeCardPath for path-bearing values shown to cards
 *  (mica.filename, mica.files.list() paths) or to the user (card titles).
 *  Takes a project-relative path and re-expresses it canvas-relative — bare
 *  name for files inside canvas, "../" prefix for files outside. */
export function canvasRelative(projectRelativePath: string, canvasRoot: string): string {
  if (!canvasRoot) return projectRelativePath;
  const prefix = canvasRoot + "/";
  if (projectRelativePath === canvasRoot) return "";
  if (projectRelativePath.startsWith(prefix)) {
    return projectRelativePath.slice(prefix.length);
  }
  // Outside canvas — pinned file or off-canvas path. Walk up out of canvasRoot
  // then point into the project-relative path.
  const escapeCount = canvasRoot.split("/").filter(Boolean).length;
  return "../".repeat(escapeCount) + projectRelativePath;
}

// ── canvasRoot fetch / cache (shared between CardRuntime and CanvasCardRuntime) ──

const canvasRootCache = new Map<string, Promise<string>>();

/** Fetch the project's canvasRoot once and reuse for every subsequent caller
 *  in the same project. Empty string when canvas IS project root. */
export function getCanvasRoot(project: string): Promise<string> {
  const cached = canvasRootCache.get(project);
  if (cached) return cached;
  const promise = fetch("/api/canvas/config", { headers: { "X-Mica-Project": project } })
    .then((r) => r.ok ? r.json() : { canvasRoot: "" })
    .then((j: { canvasRoot?: string }) => {
      const root = (j.canvasRoot ?? "").replace(/\/$/, "");
      return root === "." ? "" : root;
    })
    .catch(() => "");
  canvasRootCache.set(project, promise);
  return promise;
}

/** Drop a project's cached canvasRoot — call when the project's canvasRoot
 *  config changes (rare; project rename / canvasRoot edit). */
export function invalidateCanvasRoot(project: string): void {
  canvasRootCache.delete(project);
}
