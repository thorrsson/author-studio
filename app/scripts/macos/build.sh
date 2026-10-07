#!/bin/bash
# Builds dist/mac-universal/Author Studio.app and its disk image, signed for
# distribution.
#
#   ./scripts/macos/build.sh
#
# Signing is controlled by AUTHOR_STUDIO_SIGNING_IDENTITY (see common.sh). With
# a Developer ID identity, electron-builder signs every binary in the bundle
# with the Hardened Runtime, a secure timestamp and build/entitlements.mac.plist,
# which is what notarization requires, and the disk image is signed with the
# same identity. Without one the app falls back to an ad-hoc signature without
# the Hardened Runtime: runnable on this Mac, and on others only after Open
# Anyway. The disk image is then left unsigned.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$(app_root)"

(( $# == 0 )) || die "build.sh takes no arguments. Choose the signing identity with AUTHOR_STUDIO_SIGNING_IDENTITY."

BUILDER="node_modules/.bin/electron-builder"
[[ -x "${BUILDER}" ]] || die "electron-builder is not installed. Run npm ci first."

VERSION="$(app_version)"
IDENTITY="$(resolve_signing_identity)"
DMG="$(dmg_path)"

log "Building ${APP_NAME} ${VERSION}"
rm -rf "${APP}" "${DMG}" "${DMG}.sha256"
node scripts/build-apple-helper.mjs

if is_adhoc "${IDENTITY}"; then
    warn "signing ad-hoc because $(adhoc_reason).
         The app will run on this Mac, but other Macs open it only after Open
         Anyway, and it cannot be notarized. Set AUTHOR_STUDIO_SIGNING_IDENTITY
         to a Developer ID identity to sign for distribution."
    # The Hardened Runtime only matters for notarization, and under it library
    # validation refuses to load Electron's own ad-hoc signed frameworks.
    "${BUILDER}" --mac --publish never -c.mac.identity=- -c.mac.hardenedRuntime=false
else
    log "Signing as ${IDENTITY}"
    # electron-builder looks the identity up in the keychain search list, and
    # wants its name without the certificate type in front. Forcing code
    # signing makes a missing identity an error rather than an unsigned app.
    CSC_NAME="${IDENTITY#Developer ID Application: }" \
        "${BUILDER}" --mac --publish never -c.forceCodeSigning=true
fi

[[ -d "${APP}" ]] || die "electron-builder did not produce ${APP}"
[[ -f "${DMG}" ]] || die "electron-builder did not produce ${DMG}"

if is_adhoc "${IDENTITY}"; then
    warn "leaving ${DMG} unsigned (not distributable)."
else
    log "Verifying the app signature"
    codesign --verify --strict --deep --verbose=2 "${APP}"
    TEAM_ID="$(team_id_from_identity "${IDENTITY}")"
    SIGNED_TEAM="$(codesign --display --verbose=2 "${APP}" 2>&1 | awk -F= '/^TeamIdentifier=/ { print $2 }')"
    if [[ -n "${TEAM_ID}" && "${SIGNED_TEAM}" != "${TEAM_ID}" ]]; then
        die "${APP} is signed by team ${SIGNED_TEAM:-none}, not ${TEAM_ID}."
    fi
    # Before notarization this reports "rejected ... Unnotarized Developer ID",
    # which is expected; notarize.sh checks the app again afterwards.
    spctl --assess --type execute --verbose=2 "${APP}" || true

    # Signing the image is what lets stapler attach the notarization ticket to
    # the .dmg itself rather than only to the app inside it.
    log "Signing ${DMG} as ${IDENTITY}"
    codesign --force --sign "${IDENTITY}" --timestamp "${DMG}"
    codesign --verify --verbose=2 "${DMG}"
fi

log "Done: ${DMG} ($(du -h "${DMG}" | cut -f1))"
