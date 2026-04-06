# Card Class: calculator

A functional calculator card with persistent history.

## Rendering
Dark-themed calculator UI with a history panel (top), large display (middle), and a 4×5 button grid (bottom). Buttons are color-coded: digits (dark), operators (blue-tinted), functions (grey), equals (green). Font scales down automatically for long numbers.

## Interactions
- Click buttons or use keyboard to enter expressions.
- Keyboard mappings: digits, `+`, `-`, `*`, `/`, `.`, `Enter`/`=` to evaluate, `Backspace` to delete, `Escape` to clear.
- `C` clears the current expression. `⌫` removes the last character. `+/−` toggles sign.
- History panel shows the last 8 calculations (most recent first).

## Server Side
- `save_history`: appends a completed calculation to `calculator.json` (max 50 entries).
- History is rendered server-side on each render from the primary file.

## Data Format
Primary file: `calculator.json` — `{ "history": [{ "expr": "1+2", "result": "3" }, ...] }`
