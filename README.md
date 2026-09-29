# Author Studio

An installable, prompt-based fiction-writing plugin for **GitHub Copilot CLI**
and **Claude Code**, with a portable Agent Skill for other compatible hosts.
It supports any fiction genre, subgenre, or combination, not just sci-fi/fantasy.
It uses the model and tools you already have in your host. There is no
standalone CLI, npm installation, API client, MCP server, or credential setup.

Author Studio coordinates five perspectives: Researcher, World Designer,
Story Builder, Scene Writer, and Editor. They are roles in one conversation,
not independently running models. You direct every step. On request, an
optional [automated review](#automated-two-model-review) runs two reviewer
agents on different models.

## Install

### GitHub Copilot CLI

From a downloaded or cloned copy of this repository, register the bundled local
marketplace and install by its plugin identifier:

```sh
copilot plugin marketplace add .
copilot plugin install author-studio@author-studio-marketplace
```

Copilot CLI 1.0.89 rejects `copilot plugin install .`; local paths work through
the marketplace command instead. Local marketplace installs load this directory
live, so keep it at a stable location. Edits take effect in the next session.

Start a new Copilot CLI session, use `/skills list` to confirm discovery, then:

```text
/author-studio start A cybernetic knight in a dying world
/author-studio world
/author-studio plot
/author-studio draft 1
```

Use the skill name shown by your host's skill picker if its version namespaces
plugin skills differently. For a session-only local preview without installing:

```sh
copilot --plugin-dir .
```

### Claude Code

From the repository root, register the bundled local marketplace and install:

```sh
claude plugin marketplace add .
claude plugin install author-studio@author-studio-marketplace
```

Start a new Claude Code session, then:

```text
/author-studio:author-studio start A cybernetic knight in a dying world
/author-studio:author-studio world
/author-studio:author-studio plot
/author-studio:author-studio draft 1
```

The repeated name is intentional: Claude Code uses `/plugin-name:skill-name`.
For a session-only local preview without installing:

```sh
claude --plugin-dir .
```

### Other skill-compatible hosts

Install or copy the complete `skills/author-studio/` directory into your host's
documented skill location. Keep `references/` and `templates/` alongside
`SKILL.md`. Invocation syntax and installation support vary by host.
For automated reviews, also copy `skills/author-studio-review/` and install
`agents/author-studio-reviewer.agent.md` wherever your host loads custom agents.

For Copilot project skills without the plugin installer, the destination is
`.github/skills/author-studio/`; for Claude Code project skills, it is
`.claude/skills/author-studio/`. Do not install both the plugin and the copied
skill in the same host unless you want duplicate entries.

Web chat, Desktop, API, and local-model products are **not automatically plugin
compatible** just because they can chat. Where custom instructions or file
attachments are supported, you can manually supply the skill and its resources,
but that is a prompt-based fallback, not a native integration. No direct OpenAI,
Gemini, Ollama, LM Studio, or Hugging Face API integration is included.

## Workflow

Pass one action after the host's skill command:

| Action | Result |
| --- | --- |
| `start <concept>` | Initialize fiction of any genre or blend, without starting subsequent phases. |
| `research [focus]` | Gather a research brief; disclose unavailable browsing. |
| `world [focus]` | Develop the setting, era, social context, and relevant story rules. |
| `plot [focus]` | Develop structure, arcs, and threads suited to the genre blend and form. |
| `draft <chapter>` | Draft one chapter or agreed numbered unit; prose chapters normally run 1,000-3,000 words. |
| `edit [target or notes]` | Revise an available artifact for voice, continuity, and pacing. |
| `review_t2 [target]` | Force human review of an available artifact. |
| `state` | Explicitly display the full JSON state snapshot without changing it. |
| `help` | Show workflow actions and review directives. |

The original `/start`, `/world`, etc. are workflow actions, not global host
commands. For example, use `/author-studio help` in Copilot rather than `/help`,
which belongs to the host. A leading slash on the nested action is also valid:
`/author-studio /world`.

Ordinary responses show the requested writing output and any required review
gate, **not a state dump**. State tracking continues in the conversation.
Use `/author-studio state` in Copilot or
`/author-studio:author-studio state` in Claude Code to explicitly display the
full JSON **STATE SNAPSHOT**, including project metadata, lore, plot, characters,
chapter progress, the orchestration log, and any pending review.

### Genres, blends, and forms

Describe your creative brief in ordinary language with `start`: any genres or
subgenres, their relative emphasis if it matters, tone, audience, setting, and
form. There is no fixed genre list or default sci-fi/fantasy assumption.

```text
/author-studio start A contemporary romance about rival bakery owners. Warm, funny, grounded, no supernatural elements.
/author-studio start A historical mystery with gothic horror undertones, set in 1890s Cornwall. Mystery leads; keep the supernatural ambiguous.
/author-studio start A literary family saga spanning three generations in rural Brazil.
/author-studio start A 500-word comic western flash story about a retired outlaw trying to return a library book.
```

These are separate project examples; `start` asks before replacing existing
work. Use Claude Code's `/author-studio:author-studio` prefix there.

Research adapts to the subject; `world` can build a realistic household or
community instead of a fantasy universe; plot and editing follow the brief's
genre expectations rather than forcing magic, twists, or three acts.
Sci-fi and fantasy remain supported, alone or in any blend. Audience and tone
are independent of genre, and intentional departures from conventions are valid.

Novels, novellas, short stories, flash fiction, serials, and other requested
forms use the same workflow. For a standalone short work, agree on its scope
and use `draft 1` for the whole piece. For other forms, agree on numbered scenes
or installments. The existing chapter-named progress fields track those units;
they do not force every project into chapters. Requested lengths override the
prose-chapter default.

`project.genre` remains a string and can hold a blend such as
`historical mystery + gothic horror`; it is empty when unspecified. Existing
snapshots, including `sci_fantasy` projects, retain their genre, canon, and
chapter numbering. Unused magic or twist fields stay empty, not filled with
invented material. State is still displayed only on request.

### Human review

Confidence **<= 0.75**, missing/invalid confidence, or any contradiction triggers
a Tier 2 gate before proposed canon/progress changes are accepted. Reply using
the skill entry point with `APPROVE`, `MODIFY: <notes>`, or `REJECT`. Direct
conversational replies work too if the host retains the active skill context.

Approval accepts only the displayed proposal and stops. Unresolved
contradictions require an explicit canon resolution. Modification revises the
pending proposal and requests review again. Rejection discards the proposal,
not accepted work, and never automatically regenerates. Other worker commands
are blocked while review is pending.

These are **model instructions, not a deterministic enforcement engine**.
Confidence is a subjective assessment, not a measured probability. Tool
availability, context limits, and instruction-following depend on the host.

### Automated two-model review

When you ask for it, the `author-studio-review` skill has two independent
instances of the read-only `author-studio-reviewer` agent review one artifact
on **two different models**. It then consolidates their findings with potential
solutions, the reviewer that raised each one, and any disagreements. The
orchestrator chooses the models for each review based on the task, such as
long-context models for full chapters or a strong reasoning model for
continuity-heavy mysteries. It prefers different model families when the host
offers them. Name models in your request to override that choice.

```text
# Copilot CLI
/author-studio-review pending
/author-studio-review chapter-2-v1 focus on clue fairness

# Claude Code
/author-studio:author-studio-review pending
```

The target can be `pending` (the gated candidate), an artifact id, a file path,
or pasted text. While a gate is pending, only its candidate can be reviewed:
use `pending`, omit the target, or name the candidate's artifact id. Other
targets are not resolved until the gate is cleared. Without a pending gate, the
target defaults to the latest unambiguous artifact. Reviews are advisory: they
never edit, approve, or reject work or change state. Apply chosen fixes yourself,
for example `MODIFY: apply R1 solution 1, R3 solution 2`, or run `edit` for an
accepted artifact.

Reviews never run automatically. Two-model review requires a host that can
run plugin agents and choose a model per invocation. Otherwise, Author Studio
says so and asks before offering a clearly labeled single-perspective review.
Each review uses two additional model calls.

### Saving and resuming

State lives in the conversation by default, even when it is not printed.
Ask Author Studio to export its snapshot and accepted artifacts to a destination
you choose, or request `state` and copy the snapshot from the conversation.
File exports confirm the destination without echoing the JSON unless requested.
If file tools are unavailable, Author Studio offers a copyable snapshot instead.
The plugin does not automatically save files or remember other sessions.

In a new session, provide the snapshot plus relevant manuscript/lore artifacts
and ask Author Studio to resume. Imported state is checked before adoption;
pending review remains pending. A snapshot alone is not a backup of the full
accepted manuscript.

## Distribution

Install from [thorrsson/author-studio](https://github.com/thorrsson/author-studio):

```sh
# Copilot CLI: direct repository installation
copilot plugin install thorrsson/author-studio

# Claude Code: register this repository as a marketplace, then install
claude plugin marketplace add thorrsson/author-studio
claude plugin install author-studio@author-studio-marketplace
```

The Copilot manifest uses the supported legacy format for broad compatibility.
The Claude manifest and shared marketplace live under `.claude-plugin/`.
Both hosts can install through that marketplace and load the same skills and
reviewer agent from the default `skills/` and `agents/` locations; there is no
generated copy of the workflow to drift out of sync.

## Development

No build or runtime dependencies are required. Node.js 18+ is used only for
the repository's structural tests:

```sh
node --test tests/plugin.test.mjs
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
copilot --plugin-dir . plugin list --json
```

Structural tests check packaging, resource links, metadata, and the initial
state. They do **not** prove model behavior. `tests/scenarios.json` provides
manual acceptance scenarios to run in a fresh host conversation, including
confidence boundaries and pending-review transitions. Use the host's actual
skill entry point for each scenario action.

`prompt.md` is the original design input, preserved unchanged. Its standalone
CLI, npm commands, API examples, and automatic cross-session persistence claims
are not implemented. The installed skill is authoritative: it resolves the
original threshold gap conservatively, defaults to 1,000-3,000-word chapters,
shows state only on request rather than on every response, and requires an
explicit next command after approval or rejection.

Format references:
[Copilot plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating),
[Claude plugins](https://code.claude.com/docs/en/plugins-reference),
and [Agent Skills](https://agentskills.io/specification).
