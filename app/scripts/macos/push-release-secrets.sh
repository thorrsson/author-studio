#!/bin/bash
# Copies the release workflow's signing and notarization secrets from a .env
# file to the `release` environment on GitHub.
#
#   ./scripts/macos/push-release-secrets.sh [--dry-run] [path/to/.env]
#
# The file defaults to .env at the top of the repository, which is gitignored.
# It is read the way `source .env` reads it, so it holds bash assignments, with
# or without `export`:
#
#   MACOS_CERTIFICATE_P12       the Developer ID .p12, base64-encoded, or its path
#   MACOS_CERTIFICATE_PASSWORD  the password set when exporting it
#   MACOS_SIGNING_IDENTITY      Developer ID Application: Your Name (TEAMID)
#   MACOS_TEAM_ID               the 10-character Team ID
#   NOTARY_API_KEY_P8           the AuthKey_<KEY_ID>.p8: base64-encoded, its
#                               contents, or its path
#   NOTARY_API_KEY_ID           the key's ID, from App Store Connect
#   NOTARY_API_ISSUER_ID        the key's issuer ID, from App Store Connect
#
# A path can start with ~/ or be relative to the .env file; either way, it's the
# file's contents that are uploaded, since the runner can't see the file.
#
# Everything is checked before anything is uploaded: the tests the workflow
# applies, plus the certificate's expiry and private key, and the API key with
# Apple. A wrong password or an expired certificate fails here rather than in
# CI. A .p12 from Keychain Access, which the workflow refuses for its RC2
# encryption, is repackaged with 3DES under the same password; the .env file
# is left as it is. Values reach gh on stdin, never as arguments, and are
# never printed. If the environment doesn't exist it is created, limited to
# desktop-v* tags; one still in GitHub's default state, which lets any branch
# or tag deploy, is limited the same way. Settings someone chose are left
# alone. --dry-run checks everything without uploading or changing anything.
#
# Needs gh, signed in with admin access to the repository. The API key is
# checked with Apple when Xcode or its Command Line Tools are installed.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ENVIRONMENT="release"
TAG_PATTERN="desktop-v*"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=1
    shift
fi
(( $# <= 1 )) || die "usage: push-release-secrets.sh [--dry-run] [path/to/.env]"
ENV_FILE="${1:-$(git -C "$(app_root)" rev-parse --show-toplevel)/.env}"
[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} not found."
ENV_FILE="$(cd "$(dirname "${ENV_FILE}")" && pwd)/$(basename "${ENV_FILE}")"
command -v gh > /dev/null || die "gh is not installed. See https://cli.github.com"
cd "$(app_root)"

ENV_DIR="$(dirname "${ENV_FILE}")"
if git -C "${ENV_DIR}" rev-parse --is-inside-work-tree > /dev/null 2>&1 \
    && ! git -C "${ENV_DIR}" check-ignore -q "${ENV_FILE}"; then
    warn "${ENV_FILE} is not gitignored. Add it to .gitignore so it can't be committed."
fi

# Each value is read in a clean environment, so a variable already set in this
# shell can't stand in for one missing from the file. The file's own output
# and errors are discarded because either could include a value.
read_env() {
    local value
    # shellcheck disable=SC2016  # expanded by the inner bash, not this one
    value="$(env -i HOME="${HOME}" PATH="${PATH}" bash -c \
        'set -a; source "$1" > /dev/null 2>&1 || exit 1; printenv "$2" || true' _ "${ENV_FILE}" "${1}")" \
        || die "${ENV_FILE} could not be loaded. Check it with: bash -n '${ENV_FILE}'"
    [[ -n "${value}" ]] || die "${1} is not set in ${ENV_FILE}."
    [[ "${value}" != *$'\r'* ]] || die "${1} contains a carriage return; ${ENV_FILE} has Windows line endings."
    printf '%s' "${value}"
}

# A value that names a file stands for the file's contents.
file_path() {
    # shellcheck disable=SC2088  # matching a literal ~ left unexpanded in quotes
    case "${1}" in
        "~/"*) printf '%s/%s' "${HOME}" "${1#\~/}" ;;
        /*) printf '%s' "${1}" ;;
        *) printf '%s/%s' "${ENV_DIR}" "${1}" ;;
    esac
}

log "Reading ${ENV_FILE}"
P12="$(read_env MACOS_CERTIFICATE_P12)"
P12_PASSWORD="$(read_env MACOS_CERTIFICATE_PASSWORD)"
IDENTITY="$(read_env MACOS_SIGNING_IDENTITY)"
TEAM_ID="$(read_env MACOS_TEAM_ID)"
API_KEY="$(read_env NOTARY_API_KEY_P8)"
API_KEY_ID="$(read_env NOTARY_API_KEY_ID)"
API_ISSUER_ID="$(read_env NOTARY_API_ISSUER_ID)"

[[ "${TEAM_ID}" =~ ^[A-Z0-9]{10}$ ]] || die "MACOS_TEAM_ID should be the 10-character Team ID."
[[ "${IDENTITY}" == "Developer ID Application: "*" (${TEAM_ID})" ]] \
    || die "MACOS_SIGNING_IDENTITY should read \"Developer ID Application: Your Name (${TEAM_ID})\"."
[[ "${API_KEY_ID}" =~ ^[A-Z0-9]+$ ]] || die "NOTARY_API_KEY_ID should be the key's ID from App Store Connect."
[[ "${API_ISSUER_ID}" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] \
    || die "NOTARY_API_ISSUER_ID should be the issuer ID from App Store Connect, which looks like a UUID."

log "Checking the certificate"
if [[ -f "$(file_path "${P12}")" ]]; then
    P12="$(base64 < "$(file_path "${P12}")" | tr -d '\n')"
else
    P12="$(tr -d '[:space:]' <<< "${P12}")"
fi
pkcs12() {
    printf '%s' "${P12}" | base64 --decode 2>/dev/null \
        | CERT_PASSWORD="${P12_PASSWORD}" openssl pkcs12 -passin env:CERT_PASSWORD "$@"
}
OPEN=(pkcs12)
if ! pkcs12 -noout > /dev/null 2>&1; then
    pkcs12 -legacy -noout > /dev/null 2>&1 \
        || die "MACOS_CERTIFICATE_P12 isn't a .p12 file, or base64 of one, that opens with MACOS_CERTIFICATE_PASSWORD."
    OPEN=(pkcs12 -legacy)
fi
KEY_PUBLIC="$("${OPEN[@]}" -nocerts -nodes 2>/dev/null | openssl pkey -pubout 2>/dev/null || true)"
[[ -n "${KEY_PUBLIC}" ]] \
    || die "MACOS_CERTIFICATE_P12 has no private key. Export the identity from Keychain Access (My Certificates), not just the certificate."
CERT="$("${OPEN[@]}" -nokeys -clcerts 2>/dev/null || true)"
COMMON_NAME="$(openssl x509 -noout -subject -nameopt multiline,-esc_msb,utf8 <<< "${CERT}" 2>/dev/null \
    | sed -n 's/^ *commonName *= //p' || true)"
[[ "${COMMON_NAME}" == "${IDENTITY}" ]] \
    || die "MACOS_CERTIFICATE_P12 holds \"${COMMON_NAME:-no certificate}\", not MACOS_SIGNING_IDENTITY (\"${IDENTITY}\")."
[[ "$(openssl x509 -noout -pubkey <<< "${CERT}")" == "${KEY_PUBLIC}" ]] \
    || die "the private key in MACOS_CERTIFICATE_P12 doesn't belong to its certificate. Export the identity again from Keychain Access."
EXPIRES="$(openssl x509 -noout -enddate <<< "${CERT}" | sed 's/^notAfter=//')"
openssl x509 -noout -checkend 0 <<< "${CERT}" > /dev/null \
    || die "the certificate in MACOS_CERTIFICATE_P12 expired on ${EXPIRES}. Create a new one at https://developer.apple.com/account/resources/certificates"
openssl x509 -noout -checkend $(( 30 * 24 * 60 * 60 )) <<< "${CERT}" > /dev/null \
    || warn "the certificate in MACOS_CERTIFICATE_P12 expires on ${EXPIRES}. Create a new one at https://developer.apple.com/account/resources/certificates"
log "  ${COMMON_NAME}, with its private key, valid until ${EXPIRES}"

# Keychain Access encrypts the certificate with RC2, which OpenSSL 3 opens only
# with -legacy, and the workflow refuses anything that needs it. LibreSSL opens
# RC2 without -legacy, so the encryption is checked by name too. 3DES with a
# SHA-1 MAC opens without -legacy everywhere and imports on every macOS, so
# the identity is repackaged that way under the same password. The unencrypted
# key only passes through pipes.
if [[ "${OPEN[*]}" == *-legacy* || "$("${OPEN[@]}" -info -noout 2>&1 || true)" == *RC2* ]]; then
    P12="$(CERT_PASSWORD="${P12_PASSWORD}" openssl pkcs12 -export -name "${IDENTITY}" \
        -in <("${OPEN[@]}" -nokeys 2>/dev/null) -inkey <("${OPEN[@]}" -nocerts -nodes 2>/dev/null) \
        -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -passout env:CERT_PASSWORD \
        | base64 | tr -d '\n')" || die "MACOS_CERTIFICATE_P12 couldn't be repackaged."
    pkcs12 -noout > /dev/null 2>&1 && [[ "$(pkcs12 -info -noout 2>&1)" != *RC2* ]] \
        || die "MACOS_CERTIFICATE_P12 couldn't be repackaged."
    log "  Repackaged with 3DES: the workflow refuses its RC2 encryption, as Keychain Access writes it"
fi

log "Checking the App Store Connect API key"
if [[ -f "$(file_path "${API_KEY}")" ]]; then
    PEM="$(cat "$(file_path "${API_KEY}")")"
elif [[ "${API_KEY}" == *"-----BEGIN PRIVATE KEY-----"* ]]; then
    PEM="${API_KEY}"
else
    PEM="$(tr -d '[:space:]' <<< "${API_KEY}" | base64 --decode 2>/dev/null || true)"
fi
[[ "${PEM}" == *"-----BEGIN PRIVATE KEY-----"* ]] \
    || die "NOTARY_API_KEY_P8 isn't the AuthKey .p8 file, its contents, or its contents in base64."
openssl pkey -noout <<< "${PEM}" > /dev/null 2>&1 || die "NOTARY_API_KEY_P8 is damaged or incomplete."
API_KEY="$(printf '%s\n' "${PEM}" | base64 | tr -d '\n')"

# Listing past submissions is the cheapest call that proves Apple accepts the
# key, its ID and the issuer together; a typo in either ID otherwise only shows
# up when a release is notarized.
if xcrun --find notarytool > /dev/null 2>&1; then
    KEY_DIR="$(mktemp -d -t author-studio-notary-key)"
    trap 'rm -rf "${KEY_DIR}"' EXIT
    printf '%s\n' "${PEM}" > "${KEY_DIR}/AuthKey.p8"
    NOTARY_ERROR="$(xcrun notarytool history --key "${KEY_DIR}/AuthKey.p8" \
        --key-id "${API_KEY_ID}" --issuer "${API_ISSUER_ID}" 2>&1 > /dev/null)" \
        || die "notarytool couldn't sign in to Apple with NOTARY_API_KEY_P8, NOTARY_API_KEY_ID and NOTARY_API_ISSUER_ID:
       ${NOTARY_ERROR}"
    rm -rf "${KEY_DIR}"
    log "  Apple accepts it"
else
    warn "notarytool isn't installed, so Apple wasn't asked whether it accepts the API key. Install Xcode or its Command Line Tools (xcode-select --install) to check."
fi

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
    || die "couldn't tell which GitHub repository this is. Set GH_REPO=owner/name."
[[ "$(gh api "repos/${REPO}" --jq .permissions.admin)" == "true" ]] \
    || die "setting environment secrets needs admin access to ${REPO}, which $(gh api user --jq .login) doesn't have."
ENV_API="repos/${REPO}/environments/${ENVIRONMENT}"
SETTINGS="https://github.com/${REPO}/settings/environments"
# "default" is how GitHub creates an environment: any branch or tag can deploy,
# no rules, admins can bypass. Only then is it safe to send a PUT, which may
# reset the settings it leaves out.
if ENV_STATE="$(gh api "${ENV_API}" --jq 'if .deployment_branch_policy == null and (.protection_rules | length) == 0 and .can_admins_bypass != false then "default" else "configured" end' 2>&1)"; then
    :
elif [[ "${ENV_STATE}" == *"HTTP 404"* ]]; then
    ENV_STATE=missing
fi
case "${ENV_STATE}" in
    missing | default | configured) ;;
    *) die "couldn't read the ${ENVIRONMENT} environment of ${REPO}: ${ENV_STATE}" ;;
esac

# The workflow's comments explain why these matter: without them, anyone who
# can push a tag or a branch can run code with the signing key in scope.
warn_unprotected() {
    if [[ "${ENV_STATE}" == configured \
        && "$(gh api "${ENV_API}" --jq '.deployment_branch_policy == null')" == "true" ]]; then
        warn "any branch or tag can deploy to ${ENVIRONMENT}. Limit it to ${TAG_PATTERN} tags at ${SETTINGS}"
    fi
    if [[ "${ENV_STATE}" != configured \
        || "$(gh api "${ENV_API}" --jq '[.protection_rules[]? | select(.type == "required_reviewers")] | length')" == "0" ]]; then
        warn "releases can use these secrets without anyone approving the run. To require that, add yourself as a required reviewer at ${SETTINGS}"
    fi
}

if (( DRY_RUN )); then
    case "${ENV_STATE}" in
        missing) log "Dry run: all seven values check out. Would create the ${ENVIRONMENT} environment of ${REPO}, limited to ${TAG_PATTERN} tags, and set them there." ;;
        default) log "Dry run: all seven values check out. Would limit the ${ENVIRONMENT} environment of ${REPO}, which any branch or tag can deploy to, to ${TAG_PATTERN} tags, and set them there." ;;
        *) log "Dry run: all seven values check out. Would set them in the ${ENVIRONMENT} environment of ${REPO}, leaving its settings as they are." ;;
    esac
    warn_unprotected
    exit 0
fi

if [[ "${ENV_STATE}" != configured ]]; then
    if [[ "${ENV_STATE}" == missing ]]; then
        log "Creating the ${ENVIRONMENT} environment of ${REPO}, limited to ${TAG_PATTERN} tags"
    else
        log "Limiting the ${ENVIRONMENT} environment of ${REPO}, which any branch or tag could deploy to, to ${TAG_PATTERN} tags"
    fi
    gh api --method PUT "${ENV_API}" --input - > /dev/null <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
    POLICY_ERROR="$(gh api --method POST "${ENV_API}/deployment-branch-policies" \
        -f name="${TAG_PATTERN}" -f type=tag 2>&1 > /dev/null)" \
        || die "couldn't add the ${TAG_PATTERN} tag rule, so nothing can deploy to ${ENVIRONMENT} until it's added at ${SETTINGS}:
       ${POLICY_ERROR}"
fi

log "Setting the secrets of the ${ENVIRONMENT} environment of ${REPO}"
set_secret() {
    printf '%s' "${2}" | gh secret set "${1}" --env "${ENVIRONMENT}" --repo "${REPO}"
}
set_secret MACOS_CERTIFICATE_P12 "${P12}"
set_secret MACOS_CERTIFICATE_PASSWORD "${P12_PASSWORD}"
set_secret MACOS_SIGNING_IDENTITY "${IDENTITY}"
set_secret MACOS_TEAM_ID "${TEAM_ID}"
set_secret NOTARY_API_KEY_P8 "${API_KEY}"
set_secret NOTARY_API_KEY_ID "${API_KEY_ID}"
set_secret NOTARY_API_ISSUER_ID "${API_ISSUER_ID}"

gh secret list --env "${ENVIRONMENT}" --repo "${REPO}"
warn_unprotected
log "Done. Push a ${TAG_PATTERN} tag to release."
