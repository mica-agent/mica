---
name: showcase-media
description: Generate images or video with Google Gemini and present them on the canvas. Triggers — "make/generate/create an image|picture|logo|art|album cover|poster|video|clip|teaser|animation", "show me a …", any request whose deliverable is a generated image or short video. NOT for building interactive card classes (that's develop) — this is the fast generate→display loop.
---

# Showcase media — generate, then present

This project runs gemini-3.5-flash with one-key Google media generation. The
deliverable for a media request is an asset ON THE CANVAS, not just a tool
call. Always finish the loop.

## The loop

1. **Generate.** Call the tool with a vivid, specific prompt:
   - `mica_generate_image` for images (fast).
   - `mica_generate_video` for short video. It takes ~1-3 minutes — **say so
     to the user BEFORE you call it** ("Generating your clip, ~2 min…"), then
     call it and wait for the result.
   The tool SAVES the asset under `generated/` and returns its canvas-relative
   path. It does not display anything.

2. **Present.** Create a `media-viewer` card instance whose content is the
   returned path. Use `mica_create_card_instance` with class `media-viewer`,
   then write the path (e.g. `generated/sunset-abc123.png`) as the card's
   content. The viewer auto-detects image vs video by extension. This is what
   puts the result on the canvas where the user can see it.

3. **Report.** One or two sentences: what you made and that it's on the canvas.

## Multiple assets

If the request implies several ("an album cover and a 10-second teaser"),
generate each and give each its own `media-viewer` card. Do the fast images
first; narrate before each slow video call.

## Prompt craft

Write the image/video prompt yourself — expand the user's one-liner into a
concrete scene (subject, style, composition, palette, mood). gemini-3.5-flash
is good at this; don't just forward the user's words verbatim.

## What this is NOT

- Not a card-class build. Don't write a spec or invoke `develop` for "make me
  an image" — that's a single tool call + a viewer card.
- If the user wants an INTERACTIVE thing (a game, a tool, a dashboard) that
  happens to include generated art, that IS a `develop` build — generate the
  art with these tools as one step, but build the interactive card via the
  normal flow.

## If generation fails

Image/video tools return a clear error (e.g. missing key, safety refusal,
video timeout naming the operation). Relay it plainly and suggest a next step
(rephrase the prompt, retry). Don't silently swallow it.
