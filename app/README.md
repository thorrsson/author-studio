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

Builds that are not signed with an Apple or Microsoft certificate get a
warning the first time they open:

- **Mac:** If macOS says it can't verify Author Studio, click **Done**. Open
  **System Settings → Privacy & Security**, scroll down, click **Open Anyway**
  next to the Author Studio message, and confirm. You only need to do this once.
- **Windows:** If SmartScreen says "Windows protected your PC", click
  **More info**, then **Run anyway**.

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
| `test/` | Unit tests and the end-to-end smoke test. |

### Packaging and releases

```sh
npm run dist:mac     # universal .dmg (run on macOS)
npm run dist:win     # .exe installer (run on Windows)
npm run dist:linux   # .AppImage and .deb (run on Linux)
```

Output goes to `dist/`. Without signing certificates, macOS builds are left
unsigned; add `-- -c.mac.identity=-` to sign them ad hoc, which lets others
open them with **Open Anyway**. After changing `src/renderer/icon.svg`, run
`npm run icons` and commit the PNGs in `build/`.

The [Desktop app workflow](../.github/workflows/desktop.yml) runs the tests on
macOS, Windows, and Linux for every change. Pushing a tag such as
`desktop-v1.0.0` (matching `version` in `package.json`) builds all three
platforms and creates a draft GitHub release with the installers. Signing is
optional and uses these repository secrets:

| Secret | Purpose |
| --- | --- |
| `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD` | Developer ID Application certificate (base64 `.p12`) and its password. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization, so macOS opens the app without a warning. |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Windows code signing certificate (base64 `.pfx`) and its password. |
