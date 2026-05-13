#!/usr/bin/env bash
# library-project.sh — manage Mica's library-project include list.
#
# Library projects are normal Mica projects whose .mica/card-classes/
# contents are available to every other project on this machine via the
# card-class resolver. The list lives in ~/.mica/include-projects.json.
#
# Usage:
#   library-project.sh add <project-path>
#   library-project.sh remove <project-path>
#   library-project.sh list
#
# The path must be absolute and must exist. Idempotent on add/remove.

set -euo pipefail

CONFIG_DIR="${HOME}/.mica"
CONFIG_FILE="${CONFIG_DIR}/include-projects.json"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  add <abs-path>    Add a project path to the library include list
  remove <abs-path> Remove a project path from the include list
  list              Show current include list
EOF
  exit 1
}

ensure_config() {
  mkdir -p "${CONFIG_DIR}"
  if [ ! -f "${CONFIG_FILE}" ]; then
    echo '{ "include": [] }' > "${CONFIG_FILE}"
  fi
}

# Update via node so JSON stays valid even if the file was hand-edited.
update_config() {
  local op="$1"
  local target="$2"
  ensure_config
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'fs';
    const path = process.argv[1];
    const op = process.argv[2];
    const target = process.argv[3];
    let data;
    try { data = JSON.parse(readFileSync(path, 'utf-8')); } catch { data = { include: [] }; }
    if (!Array.isArray(data.include)) data.include = [];
    if (op === 'add') {
      if (!data.include.includes(target)) data.include.push(target);
    } else if (op === 'remove') {
      data.include = data.include.filter(p => p !== target);
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
    for (const p of data.include) console.log('  ' + p);
  " -- "${CONFIG_FILE}" "${op}" "${target}"
}

cmd="${1:-}"
case "${cmd}" in
  add)
    target="${2:-}"
    [ -z "${target}" ] && usage
    case "${target}" in /*) ;; *)
      echo "error: path must be absolute: ${target}" >&2
      exit 2
    ;; esac
    if [ ! -d "${target}" ]; then
      echo "error: path does not exist or is not a directory: ${target}" >&2
      exit 2
    fi
    echo "Library projects after add:"
    update_config add "${target}"
    ;;
  remove)
    target="${2:-}"
    [ -z "${target}" ] && usage
    echo "Library projects after remove:"
    update_config remove "${target}"
    ;;
  list)
    ensure_config
    echo "Library projects:"
    node --input-type=module -e "
      import { readFileSync } from 'fs';
      try {
        const data = JSON.parse(readFileSync(process.argv[1], 'utf-8'));
        const list = Array.isArray(data.include) ? data.include : [];
        if (list.length === 0) { console.log('  (none)'); }
        else { for (const p of list) console.log('  ' + p); }
      } catch (err) { console.error('  (config malformed: ' + err.message + ')'); process.exit(3); }
    " -- "${CONFIG_FILE}"
    ;;
  *)
    usage
    ;;
esac
