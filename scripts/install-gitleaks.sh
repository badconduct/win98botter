#!/usr/bin/env bash
set -euo pipefail

gitleaks_version="8.30.1"
gitleaks_archive="gitleaks_${gitleaks_version}_linux_x64.tar.gz"
gitleaks_sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
install_directory="${1:-${HOME}/.local/bin}"
temporary_directory="$(mktemp -d)"
archive_path="${temporary_directory}/${gitleaks_archive}"

cleanup() {
  rm -f -- "${archive_path}" "${temporary_directory}/gitleaks"
  rmdir -- "${temporary_directory}" 2>/dev/null || true
}
trap cleanup EXIT

if [[ "$(uname -m)" != "x86_64" ]]; then
  printf 'This pinned installer currently supports x86_64 only.\n' >&2
  exit 1
fi

mkdir -p "${install_directory}"
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/${gitleaks_archive}" \
  --output "${archive_path}"

printf '%s  %s\n' "${gitleaks_sha256}" "${archive_path}" | sha256sum --check --status
tar --extract --gzip --file "${archive_path}" --directory "${temporary_directory}" gitleaks
install -m 0755 "${temporary_directory}/gitleaks" "${install_directory}/gitleaks"

"${install_directory}/gitleaks" version
