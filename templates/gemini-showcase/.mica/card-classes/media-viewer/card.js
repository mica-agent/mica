// media-viewer — render a generated image or video from a canvas-relative
// path. The card's content is a path like "generated/foo.png" (what
// mica_generate_image / mica_generate_video return). container + mica are
// injected by CARD_SHIM — do not redeclare them.

const raw = ((await mica.getContent()) || "").trim();
const root = container.querySelector("#mv-root");

if (!raw) {
  root.innerHTML =
    '<div class="mv-empty">No media path yet. Put a canvas-relative path ' +
    '(e.g. <code>generated/foo.png</code>) as this card\'s content.</div>';
} else {
  // Resolve the canvas root so we can build a project-relative file URL.
  // /api/files/<project-relative-path>?project=<name> streams the raw bytes.
  let canvasRoot = "canvas";
  try {
    const cfg = await fetch(
      "/api/canvas/config?project=" + encodeURIComponent(mica.project || ""),
    ).then((r) => r.json());
    if (cfg && typeof cfg.canvasRoot === "string") {
      canvasRoot = cfg.canvasRoot === "." ? "" : cfg.canvasRoot.replace(/\/+$/, "");
    }
  } catch (_e) { /* fall back to "canvas" */ }

  const rel = raw.replace(/^\/+/, "");
  const projRel = canvasRoot && !rel.startsWith(canvasRoot + "/") ? canvasRoot + "/" + rel : rel;
  // The file route takes the project-relative path as a SINGLE url-encoded
  // segment (slashes → %2F), same as mica.read(). Literal slashes 404.
  const url =
    "/api/files/" + encodeURIComponent(projRel) + "?project=" + encodeURIComponent(mica.project || "");

  const ext = (rel.split(".").pop() || "").toLowerCase();
  const isVideo = ["mp4", "webm", "mov", "m4v", "ogg"].includes(ext);

  const el = window.document.createElement(isVideo ? "video" : "img");
  el.src = url;
  if (isVideo) {
    el.controls = true;
    el.setAttribute("playsinline", "");
  } else {
    el.alt = rel;
  }
  el.addEventListener("error", () => {
    root.innerHTML =
      '<div class="mv-empty">Could not load <code>' + rel + "</code>.</div>";
  });
  root.innerHTML = "";
  root.appendChild(el);
}
