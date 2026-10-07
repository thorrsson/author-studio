#!/bin/bash
# Notarizes a signed disk image with Apple and staples the ticket to it.
#
#   ./scripts/macos/notarize.sh [path-to-dmg]
#
# Defaults to dist/Author-Studio-<version>-universal.dmg. Notarization is what
# removes the "Apple could not verify" dialog, and notarizing the image covers
# the app inside it too; stapling is what makes the check work on a Mac that is
# offline the first time the image is opened.
#
# Credentials, in the order they are tried:
#
#   1. AUTHOR_STUDIO_NOTARY_PROFILE   a keychain profile, created once with
#                                     xcrun notarytool store-credentials
#   2. NOTARY_API_KEY_P8 + NOTARY_API_KEY_ID + NOTARY_API_ISSUER_ID
#                                     an App Store Connect API key; the .p8 is
#                                     a file path, its PEM content, or that
#                                     content encoded with base64
#   3. AUTHOR_STUDIO_APPLE_ID + AUTHOR_STUDIO_APPLE_PASSWORD
#                                     an app-specific password, not the account
#                                     one. The Team ID is AUTHOR_STUDIO_TEAM_ID,
#                                     or else the one the image is signed with.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$(app_root)"

if ! xcrun --find notarytool > /dev/null 2>&1 || ! xcrun --find stapler > /dev/null 2>&1; then
    die "notarytool and stapler were not found. Install Xcode or the Command Line Tools (xcode-select --install)."
fi

TARGET="${1:-$(dmg_path)}"
[[ -f "${TARGET}" ]] || die "${TARGET} not found. Run npm run dist:mac first."

KEY_FILE=""
SUBMIT_LOG=""
MOUNT=""
cleanup() {
    if [[ -n "${MOUNT}" ]]; then
        hdiutil detach "${MOUNT}" -quiet -force > /dev/null 2>&1 || true
        rmdir "${MOUNT}" 2>/dev/null || true
    fi
    rm -f "${KEY_FILE}" "${SUBMIT_LOG}"
}
trap cleanup EXIT

# Apple rejects anything that is not signed with a Developer ID and the Hardened
# Runtime, so catch it here rather than after a round trip to the service.
codesign --verify --verbose=2 "${TARGET}" 2>/dev/null \
    || die "${TARGET} is not signed. Notarization requires a Developer ID signature."
SIGNATURE="$(codesign --display --verbose=2 "${TARGET}" 2>&1)"
if grep -q 'Signature=adhoc' <<< "${SIGNATURE}"; then
    die "${TARGET} is signed ad-hoc. Set AUTHOR_STUDIO_SIGNING_IDENTITY and rebuild."
fi

NOTARY_ARGS=()
if [[ -n "${AUTHOR_STUDIO_NOTARY_PROFILE:-}" ]]; then
    log "Authenticating with keychain profile ${AUTHOR_STUDIO_NOTARY_PROFILE}"
    NOTARY_ARGS=(--keychain-profile "${AUTHOR_STUDIO_NOTARY_PROFILE}")
elif [[ -n "${NOTARY_API_KEY_P8:-}" && -n "${NOTARY_API_KEY_ID:-}" && -n "${NOTARY_API_ISSUER_ID:-}" ]]; then
    if [[ -f "${NOTARY_API_KEY_P8}" ]]; then
        KEY_PATH="${NOTARY_API_KEY_P8}"
    else
        KEY_FILE="$(mktemp -t author-studio-notary-key)"
        chmod 600 "${KEY_FILE}"
        if grep -q -- '-----BEGIN PRIVATE KEY-----' <<< "${NOTARY_API_KEY_P8}"; then
            printf '%s\n' "${NOTARY_API_KEY_P8}" > "${KEY_FILE}"
        elif ! printf '%s' "${NOTARY_API_KEY_P8}" | base64 --decode > "${KEY_FILE}" 2>/dev/null; then
            die "NOTARY_API_KEY_P8 is neither a file path, PEM content, nor valid base64."
        fi
        KEY_PATH="${KEY_FILE}"
    fi
    grep -q -- '-----BEGIN PRIVATE KEY-----' "${KEY_PATH}" \
        || die "the App Store Connect API key is not a PKCS#8 PEM file.
       Download AuthKey_${NOTARY_API_KEY_ID}.p8 from App Store Connect and pass
       its path, or encode it with:
         base64 < AuthKey_${NOTARY_API_KEY_ID}.p8 | tr -d '\\n'"
    openssl pkey -in "${KEY_PATH}" -noout > /dev/null 2>&1 \
        || die "the App Store Connect API key is malformed or incomplete."
    log "Authenticating with App Store Connect API key ${NOTARY_API_KEY_ID}"
    NOTARY_ARGS=(--key "${KEY_PATH}" --key-id "${NOTARY_API_KEY_ID}" --issuer "${NOTARY_API_ISSUER_ID}")
elif [[ -n "${AUTHOR_STUDIO_APPLE_ID:-}" && -n "${AUTHOR_STUDIO_APPLE_PASSWORD:-}" ]]; then
    TEAM_ID="${AUTHOR_STUDIO_TEAM_ID:-$(awk -F= '/^TeamIdentifier=/ { print $2 }' <<< "${SIGNATURE}")}"
    [[ "${TEAM_ID}" =~ ^[A-Z0-9]{10}$ ]] || die "set AUTHOR_STUDIO_TEAM_ID to notarize with an Apple ID."
    log "Authenticating as ${AUTHOR_STUDIO_APPLE_ID}"
    NOTARY_ARGS=(--apple-id "${AUTHOR_STUDIO_APPLE_ID}" --password "${AUTHOR_STUDIO_APPLE_PASSWORD}" --team-id "${TEAM_ID}")
else
    die "no notarization credentials.
       Set AUTHOR_STUDIO_NOTARY_PROFILE, the NOTARY_API_KEY_* trio, or
       AUTHOR_STUDIO_APPLE_ID and AUTHOR_STUDIO_APPLE_PASSWORD. To store a
       profile once:
         xcrun notarytool store-credentials author-studio \\
           --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-password>
       then export AUTHOR_STUDIO_NOTARY_PROFILE=author-studio"
fi

show_notary_log() {
    local id
    id="$(awk '/ id:/ { print $2; exit }' "${SUBMIT_LOG}")"
    if [[ -n "${id}" ]]; then
        xcrun notarytool log "${id}" "${NOTARY_ARGS[@]}" >&2 || true
    fi
}

log "Submitting ${TARGET} (this waits for Apple; usually a few minutes)"
SUBMIT_LOG="$(mktemp -t author-studio-notary)"
if ! xcrun notarytool submit "${TARGET}" "${NOTARY_ARGS[@]}" --wait --timeout 30m | tee "${SUBMIT_LOG}"; then
    show_notary_log
    die "notarization failed"
fi

# notarytool exits 0 for a submission it managed to *make*, including one Apple
# then rejected, so the status line is the thing that actually has to be checked.
if ! grep -q 'status: Accepted' "${SUBMIT_LOG}"; then
    warn "Apple did not accept the submission; full log follows"
    show_notary_log
    die "notarization was not accepted"
fi

log "Stapling the ticket"
xcrun stapler staple "${TARGET}"
xcrun stapler validate "${TARGET}"

# The real acceptance test: what Gatekeeper says about the image a user just
# downloaded, and about the app they drag out of it. Anything other than
# "accepted" here means the download will warn.
log "Gatekeeper assessment of the disk image"
spctl --assess --type open --context context:primary-signature --verbose=2 "${TARGET}"

MOUNT="$(mktemp -d -t author-studio-dmg)"
hdiutil attach "${TARGET}" -readonly -nobrowse -noautoopen -mountpoint "${MOUNT}" > /dev/null
log "Gatekeeper assessment of the app inside"
spctl --assess --type execute --verbose=2 "${MOUNT}/${APP_NAME}.app"

log "Notarized: ${TARGET}"
