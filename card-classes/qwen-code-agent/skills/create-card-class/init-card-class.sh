#!/bin/bash
# Initialize a new card class with the template render.js
# Usage: init-card-class.sh <name> <badge> <title>
# Example: init-card-class.sh moon-orbit 3D "Moon Orbit"

set -euo pipefail

NAME="${1:?Usage: init-card-class.sh <name> <badge> <title>}"
BADGE="${2:?Usage: init-card-class.sh <name> <badge> <title>}"
TITLE="${3:?Usage: init-card-class.sh <name> <badge> <title>}"

CLASS_DIR="/opt/mica/project-card-classes/${NAME}"
TEMPLATE_DIR="/opt/mica/card-classes/qwen-code-agent/skills/create-card-class"

if [ -d "$CLASS_DIR" ]; then
  echo "Card class '${NAME}' already exists at ${CLASS_DIR}"
  exit 1
fi

# Create directory
mkdir -p "$CLASS_DIR"

# Copy and customize template render.js
sed -e "s/\\.EXTENSION/.${NAME}/" \
    -e "s/\"BADGE\"/\"${BADGE}\"/" \
    -e "s/\"TITLE\"/\"${TITLE}\"/" \
    "$TEMPLATE_DIR/template-render.js" > "$CLASS_DIR/render.js"

# Create seed data file
echo '{}' > "$CLASS_DIR/~data.json"

echo "Created card class '${NAME}' at ${CLASS_DIR}"
echo "Files:"
echo "  ${CLASS_DIR}/render.js    ← metadata configured, render function ready"
echo "  ${CLASS_DIR}/~data.json   ← seed data for new instances"
echo ""
echo "Next steps:"
echo "  1. Write ${CLASS_DIR}/card.html (your card UI)"
echo "  2. Add server exports to render.js if needed"
echo "  3. Run: test-card-class.sh ${NAME}"
