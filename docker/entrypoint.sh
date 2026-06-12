#!/bin/sh
set -eu

data_dir="${SANDI_DATA_DIR:-/app/data}"
bundled_skills_root="${SANDI_BUNDLED_SKILLS_ROOT:-/app/bundled-data/skills}"

is_truthy() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

data_dir_has_persistent_mount() {
  dir="$1"
  awk -v dir="$dir" '
    function unescape_mount_path(value) {
      gsub(/\\040/, " ", value)
      gsub(/\\011/, "\t", value)
      gsub(/\\012/, "\n", value)
      gsub(/\\134/, "\\", value)
      return value
    }
    {
      mount_path = unescape_mount_path($5)
      if (mount_path == "/" || mount_path == "") next
      if (dir == mount_path || index(dir, mount_path "/") == 1) found = 1
    }
    END {
      exit found ? 0 : 1
    }
  ' /proc/self/mountinfo
}

sync_builtin_skills() {
  source_root="$1"
  target_root="$2"

  if [ ! -d "$source_root" ]; then
    return 0
  fi

  if [ -d "$target_root/core/builtin" ]; then
    rm -rf "$target_root/core/builtin"
  fi
  if [ -d "$source_root/core/builtin" ]; then
    mkdir -p "$target_root/core"
    cp -a "$source_root/core/builtin" "$target_root/core/"
  fi
  mkdir -p "$target_root/core/custom"

  if [ -d "$target_root/surfaces" ]; then
    find "$target_root/surfaces" -mindepth 2 -maxdepth 2 -type d -name builtin -exec rm -rf {} +
  fi

  if [ -d "$source_root/surfaces" ]; then
    find "$source_root/surfaces" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r surface_dir; do
      surface_name="$(basename "$surface_dir")"
      mkdir -p "$target_root/surfaces/$surface_name/custom"
      if [ -d "$surface_dir/builtin" ]; then
        mkdir -p "$target_root/surfaces/$surface_name"
        cp -a "$surface_dir/builtin" "$target_root/surfaces/$surface_name/"
      fi
    done
  fi
}

mkdir -p "$data_dir"

if ! is_truthy "${SANDI_ALLOW_EPHEMERAL_DATA:-}" && ! data_dir_has_persistent_mount "$data_dir"; then
  cat >&2 <<EOF
Refusing to start Sandi because SANDI_DATA_DIR is not on a Docker volume or bind mount.

Sandi stores memory, conversations, reminders, Pi auth, Pi sessions, generated files,
and private config under:
  $data_dir

Run with a named volume or bind mount, for example:
  docker run --volume sandi-data:$data_dir ghcr.io/sandi-black/sandi:latest
  docker compose up -d

For disposable test containers only, set SANDI_ALLOW_EPHEMERAL_DATA=1.
EOF
  exit 64
fi

sync_builtin_skills "$bundled_skills_root" "$data_dir/skills"

exec "$@"
