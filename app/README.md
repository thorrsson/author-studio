# Author Studio desktop app

Author Studio as an app you install like any other. It runs the same workflow
as the [Author Studio plugin](../README.md), with the same five helpers and the
same review gates. You don't need Copilot CLI, Claude Code, or a terminal.
You choose which AI model does the writing:

- **Claude** from Anthropic, using your API key.
- **GPT** from OpenAI, using your API key.
- **A local or network server** that speaks the OpenAI API, such as Ollama,
  LM Studio, or llama.cpp. It can run on this computer or another one on your
  network. Hosted services with OpenAI-compatible APIs also work, with an
  optional API key.
- **Apple Intelligence** on supported Macs. It runs privately on the Mac and
  costs nothing.

You can add several models, switch between them from the sidebar, and pick
different models for the optional automatic reviewers.

## Install

Download the file for your computer from the
[releases page](https://github.com/thorrsson/author-studio/releases):

| Computer | File | How to install |
| --- | --- | --- |
| Mac (Apple silicon or Intel) | `Author-Studio-<version>-universal.dmg` | Open the file and drag **Author Studio** to **Applications**. |
| Windows 10 or 11 | `Author-Studio-Setup-<version>.exe` | Run the file. Author Studio installs for your account and opens. |
| Ubuntu, Debian | `Author-Studio-<version>-amd64.deb` | Open the file with your software installer, or run `sudo apt install ./Author-Studio-*.deb`. |
| Other Linux | `Author-Studio-<version>-x86_64.AppImage` | Make the file executable, then open it. |

The Mac app is signed and notarized by Apple, so it opens like any other app.
Two kinds of download still show a warning the first time they open:

- **Windows:** The installer isn't signed yet. If SmartScreen says "Windows
  protected your PC", click **More info**, then **Run anyway**.
- **Mac test builds** (from a workflow run rather than the releases page): If
  macOS says it can't verify Author Studio, click **Done**. Open
  **System Settings → Privacy & Security**, scroll down, click **Open Anyway**
  next to the Author Studio message, and confirm. You only need to do this once.

## Choosing an AI model

The first screen asks you to connect a model. You can change this later in
**Settings**.

### Claude or GPT

Create an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys)
(Claude) or [platform.openai.com](https://platform.openai.com/api-keys) (GPT),
then paste it into Author Studio. These services bill you for what you use,
so check their pricing for the model you choose. Use **Test connection** to
check the key before you save.

### A local or network server

Start your server, choose it from the list, and Author Studio fills in the
usual address. To use a server on another computer, enter that computer's
address, for example `192.168.1.20:11434`. Then click **Find models**.

- **Ollama:** the server must accept connections from your network. Set
  `OLLAMA_HOST=0.0.0.0` on the computer that runs Ollama, then restart it.
- **LM Studio:** turn on **Serve on Local Network** in the Developer tab.
- **Mac:** the first time Author Studio contacts a server on your network,
  macOS asks for permission to find devices on your local network. Click
  **Allow**. You can change this later in **System Settings → Privacy &
  Security → Local Network**.

Under **Advanced**, set **Context window** to what your server is configured
for. Small local models write shorter, simpler chapters than Claude or GPT and
send more work to you for review.

### Apple Intelligence

Requires a Mac with Apple silicon running macOS 26 or later, with Apple
Intelligence turned on in **System Settings → Apple Intelligence & Siri**.
Author Studio tells you if anything is missing.

Apple's on-device model is small and reads about 3,000 words at a time, so
Author Studio gives it shorter instructions and less of your story at once.
Expect simpler writing and more steps that need your review. It works well for
research, setting notes, and short pieces; for full chapters, Claude, GPT, or
a larger local model does better.

**Allow mature themes** is on by default. It uses Apple's less restrictive
content filter so the model can write crime, conflict, and other dark
material that much fiction needs. Turn it off in the connection's settings if
you prefer Apple's standard filter, which declines more requests.

## How it works

Start a project with a story idea. Author Studio can turn the idea into a
creative brief that sets the form, voice, and scope. Then pick a step: research,
setting, story plan, writing, or revision.

Each helper rates how confident it is in its work. Work rated above 75%, with
no contradictions of your accepted story and nothing unfinished, is accepted
automatically. Anything else waits for you to approve it, ask for changes, or
reject it. Your story bible changes only when you accept something.

The **History** tab shows every decision, and you can download the manuscript
as a Word document from the **Manuscript** tab.

## Your data and privacy

- Projects are saved on your computer. Use **Help → Show Projects Folder** to
  find them. They live in `~/Library/Application Support/Author Studio` on a
  Mac, `%APPDATA%\Author Studio` on Windows, and `~/.config/Author Studio` on
  Linux.
- API keys are encrypted with your system's keychain (Keychain on a Mac,
  Windows' data protection, or your Linux keyring). On Linux without a keyring
  such as GNOME Keyring or KWallet, keys get only basic protection, and
  Settings tells you so.
- A saved key is only sent to the service or server it was entered for. If you
  change a server connection to a different address, enter its key again.
- Your writing is sent only to the AI model you choose. Apple Intelligence and
  local servers keep it on your own computers. Author Studio has no account,
  analytics, or tracking.
- **History → Back up project** saves a complete copy you can restore with
  **File → Open Backup or State File**.

## Moving between the app and the plugin

**History → Export state file for the plugin** saves the story bible and
progress in the plugin's format. Attach it in Copilot CLI or Claude Code and ask
Author Studio to resume. Going the other way, **File → Open Backup or State
File** imports a state snapshot saved from the plugin. A state file holds the
story bible and progress but not the full manuscript, so use a backup to move a
whole project between computers.

## Development

Requires Node.js 22 or later. Building the Apple Intelligence helper requires
macOS with Xcode 26 or later.

```sh
cd app
npm ci
npm run build:apple-helper   # macOS only; needed for Apple Intelligence
npm start                    # run the app from source
npm test                     # unit tests
npm run test:e2e             # end-to-end test against a scripted model server
```

`SMOKE_SCREENSHOTS=<folder> npm run test:e2e` saves a screenshot of each screen.
`AUTHOR_STUDIO_EXECUTABLE=<path to app binary> npm run test:e2e` runs the same
test against a packaged build. `AUTHOR_STUDIO_USER_DATA=<folder>` runs the app
with a separate data folder.

### Layout

| Folder | Contents |
| --- | --- |
| `src/core/` | The workflow engine: state, prompts, response parsing, review gates, and canon patches. It reads the prompts from the plugin's `skills/` and `agents/` folders, so both stay in step. |
| `src/providers/` | Claude, OpenAI, OpenAI-compatible, and Apple Intelligence connections. |
| `src/main/` | Electron main process: windows, menus, settings and encrypted keys, project files, Word export. |
| `src/preload/`, `src/renderer/` | The interface, in plain JavaScript and CSS with a strict content security policy. |
| `native/apple-intelligence/` | Swift helper that calls Apple's Foundation Models framework. |
| `scripts/macos/` | Build, sign, notarize, and release the Mac app. |
| `test/` | Unit tests and the end-to-end smoke test. |

### Packaging

```sh
npm run dist:mac      # universal .dmg (run on macOS)
npm run release:mac   # the same, tested, notarized, and checksummed
npm run dist:win      # .exe installer (run on Windows)
npm run dist:linux    # .AppImage and .deb (run on Linux)
```

Output goes to `dist/`. After changing `src/renderer/icon.svg`, run
`npm run icons` and commit the PNGs in `build/`.

### Signing and notarizing for macOS

The Mac app ships as a signed, notarized `.dmg`, so Gatekeeper opens it without
a warning. Three scripts in `scripts/macos/` do the work:

| Script | What it does |
| --- | --- |
| `build.sh` (`npm run dist:mac`) | Builds the Apple Intelligence helper and the universal app, signs every binary with the Hardened Runtime and a secure timestamp, then signs the disk image. |
| `notarize.sh [dmg]` | Submits the image to Apple, waits for the verdict, staples the ticket, and checks the image and the app inside it with Gatekeeper. |
| `release.sh` (`npm run release:mac`) | Unit tests, then `build.sh`, then `notarize.sh`, then a SHA-256 checksum beside the image. |

Without a Developer ID, the app is signed ad hoc and notarization is skipped,
with a warning: the build runs on the Mac that made it, and on others only
after **Open Anyway**. `AUTHOR_STUDIO_REQUIRE_NOTARIZATION=1` turns that
warning into a failure, which is how the release workflow runs, so a release
can't quietly ship unnotarized. `AUTHOR_STUDIO_SKIP_TESTS=1` skips the unit
tests.

**Signing.** The scripts use the first `Developer ID Application` identity in
the keychain; `security find-identity -v -p codesigning` lists them. To choose
one, or to force an ad hoc build with `-`:

```sh
export AUTHOR_STUDIO_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
```

`build/entitlements.mac.plist` only allows JIT compilation, which Electron's
JavaScript engine needs under the Hardened Runtime. Nothing else relaxes it.

**Notarizing.** Credentials come from the environment, tried in this order:

```sh
# 1. A keychain profile, best on a laptop. Store it once:
xcrun notarytool store-credentials author-studio \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
export AUTHOR_STUDIO_NOTARY_PROFILE=author-studio

# 2. An App Store Connect API key, best for CI. NOTARY_API_KEY_P8 is the .p8
#    file's path, its contents, or its contents in base64:
export NOTARY_API_KEY_ID=... NOTARY_API_ISSUER_ID=... NOTARY_API_KEY_P8=~/private_keys/AuthKey_XXX.p8

# 3. An Apple ID with an app-specific password (never the account password):
export AUTHOR_STUDIO_APPLE_ID=you@example.com AUTHOR_STUDIO_APPLE_PASSWORD=abcd-efgh-ijkl-mnop
```

`notarytool` exits successfully for a submission Apple went on to reject, so
`notarize.sh` checks the verdict itself and prints Apple's log when it isn't
`Accepted`.

### Releases

The [Desktop app workflow](../.github/workflows/desktop.yml) runs the tests on
macOS, Windows, and Linux for every change, and builds unsigned test copies
from `main`. The
[Desktop release workflow](../.github/workflows/desktop-release.yml) publishes
a release. To make one, raise `version` in `package.json` on `main`, then open
**Actions → Desktop release → Run workflow** and run it on `main`. It tags that
commit `desktop-v<version>` and starts a second run on the tag. That run
builds, signs, and notarizes the Mac image, tests the signed app, builds the
Windows and Linux installers, and publishes them all as a GitHub release. A
version with a suffix, such as `1.1.0-beta.1`, is published as a pre-release.

Pushing the tag yourself does the same thing:

```sh
git tag desktop-v1.0.0 && git push origin desktop-v1.0.0
```

A version that's already released is refused. If a release run fails, re-run
it from the tag's run, or run the workflow on `main` again, which reuses the
tag while it still points at the same commit.

The Mac build needs these secrets, which belong to a **`release` environment**
rather than to the repository:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12` | The Developer ID Application certificate and its private key, exported from Keychain Access as `.p12`, base64-encoded. |
| `MACOS_CERTIFICATE_PASSWORD` | The password set during that export. |
| `MACOS_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `MACOS_TEAM_ID` | The 10-character Team ID. |
| `NOTARY_API_KEY_P8` | The App Store Connect `AuthKey_<KEY_ID>.p8` file, base64-encoded. |
| `NOTARY_API_KEY_ID` | The key's ID, from App Store Connect. |
| `NOTARY_API_ISSUER_ID` | The key's issuer ID, from App Store Connect. |

To set them, put them in a `.env` file at the top of the repository, which is
gitignored. Files can be given by path, relative to the `.env` file or from
`~/`, and the script encodes them:

```sh
export MACOS_CERTIFICATE_P12=~/Desktop/DeveloperID.p12
export MACOS_CERTIFICATE_PASSWORD='the export password'
export MACOS_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export MACOS_TEAM_ID=TEAMID
export NOTARY_API_KEY_P8=~/private_keys/AuthKey_KEYID.p8
export NOTARY_API_KEY_ID=KEYID
export NOTARY_API_ISSUER_ID=00000000-0000-0000-0000-000000000000
```

Then, with [`gh`](https://cli.github.com) signed in as an admin of the
repository:

```sh
app/scripts/macos/push-release-secrets.sh --dry-run   # checks, changes nothing
app/scripts/macos/push-release-secrets.sh
```

Nothing is uploaded until every value passes the workflow's own checks and a
few more. The password must open the `.p12`, which must hold the private key
of an unexpired certificate named by `MACOS_SIGNING_IDENTITY`. Apple must also
accept the API key. Keychain Access encrypts `.p12` files with RC2, which the
workflow refuses, so the script repackages them with 3DES under the same
password; the file itself is left alone. Values reach `gh` on standard input
and are never printed.

If the `release` environment doesn't exist, the script creates it, limited to
`desktop-v*` tags. If it still has GitHub's default settings, the script
limits it the same way, and it leaves settings you chose alone. Also add
yourself as a required reviewer, under **Settings → Environments → release**,
or restrict who can create `desktop-v*` tags with a tag ruleset. The workflow
refuses a tag whose commit isn't on `main`, but that check runs from the
tagged commit's own copy of the workflow, so it catches mistakes, not someone
who can push a tag and choose the scripts it points at; the job runs those
with the signing and notarization keys in scope. That's why the workflow
starts a separate run on the tag, rather than signing from `main`. The
certificate is imported into a throwaway keychain that is deleted at the end
of the job.

Windows signing is optional: set `WINDOWS_CERTIFICATE` (a base64 `.pfx`) and
`WINDOWS_CERTIFICATE_PASSWORD` as secrets of the `release` environment to sign
the installer. The Windows build runs in that environment, apart from Linux.
