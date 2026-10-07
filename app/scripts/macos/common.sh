#!/bin/bash
# Shared configuration and helpers for the macOS packaging scripts.
# Sourced, never executed directly.

MACOS_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Author Studio"
DIST="dist"
# shellcheck disable=SC2034  # used by the scripts that source this file
APP="${DIST}/mac-universal/${APP_NAME}.app"

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Everything runs from app/ so the paths above are stable.
app_root() {
    (cd "${MACOS_SCRIPTS}/../.." && pwd)
}

# The version lives in package.json, where electron-builder also reads it.
app_version() {
    node -p "require('./package.json').version"
}

dmg_path() {
    printf '%s/Author-Studio-%s-universal.dmg' "${DIST}" "$(app_version)"
}

# Resolve the codesigning identity once, so the app and the disk image are
# signed by the same thing.
#
#   AUTHOR_STUDIO_SIGNING_IDENTITY  an explicit identity or SHA-1 hash; "-" forces ad-hoc
#   (unset)                         the first Developer ID Application identity in the
#                                   keychain, or ad-hoc if there is none
#
# Ad-hoc signatures are fine locally but cannot be notarized: Gatekeeper on
# another Mac will refuse the result, so the release path checks for this.
resolve_signing_identity() {
    if [[ -n "${AUTHOR_STUDIO_SIGNING_IDENTITY:-}" ]]; then
        printf '%s' "${AUTHOR_STUDIO_SIGNING_IDENTITY}"
        return
    fi
    local found
    # awk reads to the end rather than exiting at the first match, which would
    # leave security writing to a closed pipe and fail the pipeline.
    found="$(security find-identity -v -p codesigning 2>/dev/null \
        | awk -F'"' '/Developer ID Application/ && !found { print $2; found = 1 }')"
    if [[ -n "${found}" ]]; then
        printf '%s' "${found}"
        return
    fi
    printf '%s' '-'
}

is_adhoc() { [[ "${1}" == "-" ]]; }

# Why resolve_signing_identity settled on ad-hoc, for the warnings that say so.
adhoc_reason() {
    if [[ "${AUTHOR_STUDIO_SIGNING_IDENTITY:-}" == "-" ]]; then
        printf '%s' 'AUTHOR_STUDIO_SIGNING_IDENTITY is "-"'
    else
        printf '%s' 'there is no Developer ID Application identity in the keychain'
    fi
}

# The Team ID lives in parentheses at the end of a Developer ID identity name.
team_id_from_identity() {
    local identity="${1}"
    if [[ -n "${AUTHOR_STUDIO_TEAM_ID:-}" ]]; then
        printf '%s' "${AUTHOR_STUDIO_TEAM_ID}"
        return
    fi
    if [[ "${identity}" =~ \(([A-Z0-9]{10})\)$ ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

# Credentials for notarize.sh, in the order it tries them. See that script.
has_notary_credentials() {
    if [[ -n "${AUTHOR_STUDIO_NOTARY_PROFILE:-}" ]]; then
        return 0
    fi
    if [[ -n "${NOTARY_API_KEY_P8:-}" && -n "${NOTARY_API_KEY_ID:-}" && -n "${NOTARY_API_ISSUER_ID:-}" ]]; then
        return 0
    fi
    [[ -n "${AUTHOR_STUDIO_APPLE_ID:-}" && -n "${AUTHOR_STUDIO_APPLE_PASSWORD:-}" ]]
}
