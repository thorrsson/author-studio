#!/bin/bash
# One command from a clean checkout to a notarized, distributable disk image.
#
#   ./scripts/macos/release.sh
#
# Runs the unit tests, builds and signs the app and its disk image, notarizes
# the image, and writes its SHA-256 checksum. Notarization is skipped, with a
# loud warning rather than an error, when there is no Developer ID identity or
# no credentials, so the same command still produces a local build. Set
# AUTHOR_STUDIO_REQUIRE_NOTARIZATION=1 (the release workflow does) to make that
# a failure instead, and AUTHOR_STUDIO_SKIP_TESTS=1 to skip the tests.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$(app_root)"

VERSION="$(app_version)"
IDENTITY="$(resolve_signing_identity)"
DMG="$(dmg_path)"

log "Releasing ${APP_NAME} ${VERSION}"

# Decided before building, so a release that cannot be notarized fails in
# seconds rather than after the build.
SKIP_REASON=""
if is_adhoc "${IDENTITY}"; then
    SKIP_REASON="the build is signed ad-hoc because $(adhoc_reason)"
elif ! has_notary_credentials; then
    SKIP_REASON="no notarization credentials are configured"
fi
if [[ -n "${SKIP_REASON}" && "${AUTHOR_STUDIO_REQUIRE_NOTARIZATION:-0}" == "1" ]]; then
    die "notarization required but ${SKIP_REASON}."
fi

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    warn "the working tree is dirty; the build will not match any commit."
fi

if [[ "${AUTHOR_STUDIO_SKIP_TESTS:-0}" != "1" ]]; then
    log "Running unit tests"
    npm test
fi

"${MACOS_SCRIPTS}/build.sh"

if [[ -n "${SKIP_REASON}" ]]; then
    warn "skipping notarization: ${SKIP_REASON}. ${DMG} is a local build:
         opening it on another Mac will show 'Apple could not verify' or refuse
         outright."
else
    "${MACOS_SCRIPTS}/notarize.sh" "${DMG}"
fi

# A checksum published beside the download lets anyone confirm they got the same
# bytes, which is the one integrity check that does not depend on Apple. It is
# written from inside dist/ so the recorded name is the bare file, which is what
# `shasum -c` in a downloads folder has to find. Stapling rewrites the image, so
# this comes last.
(cd "${DIST}" && shasum -a 256 "$(basename "${DMG}")" | tee "$(basename "${DMG}").sha256")

log "Release artifacts in ${DIST}/"
ls -lh "${DMG}" "${DMG}.sha256"
