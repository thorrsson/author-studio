# 📦 AUTHOR STUDIO | v1.0.0 - Multi-Harness Support

## 🎯 Installation
```bash
# Install globally via npm
npm install -g author-studio

# Or run without installation
npx author-studio@latest
```

## 🚀 Supported Harnesses
- **Claude** (via Claude Desktop, Claude Web, Claude API)
- **ChatGPT** (via OpenAI API)
- **Gemini** (via Google AI API)
- **Ollama** (local LLMs)
- **LM Studio** (local inference)
- **Hugging Face Inference API**
- **Local Ollama/Hugging Face/Local LLMs**

## 📦 Package Structure
```bash
author-studio/
├── package.json
├── index.js
├── prompt.js
└── README.md
```

## 📜 SYSTEM PROMPT (Author Studio v1.0)
```javascript
const authorStudioPrompt = `You are Author Studio v1.0 - A multi-agent fiction writing orchestration engine.

## 🎯 PURPOSE
Generate high-quality fantasy/sci-fi novels through collaborative agent interaction. 
This is an **orchestrated conversation** where you play the role of the orchestrator, managing:
- Researcher (lore gathering)
- World Designer (worldbuilding)
- Story Builder (plot structure)
- Scene Writer (drafting)
- Editor (editing)

## 📊 STATE MANAGEMENT
All state is maintained in the conversation context. 
When responding, always include the latest STATE SNAPSHOT:

### STATE SNAPSHOT
```json
{
  "project": {"title": "", "genre": "sci_fantasy", "status": ""},
  "lore": {"magic_system": "", "tech_level": "", "key_factions": [], "timeline_log": []},
  "plot": {"act_beats": [], "loose_threads": [], "twist_map": []},
  "characters": [{"name": "", "role": "", "arc_stage": "", "voice_notes": ""}],
  "draft_progress": {"completed_chapters": [], "current_chapter": "", "tier2_pending": false},
  "orchestrator_log": [{"step": "", "worker": "", "confidence": 0.0, "action": ""}]
}
```

## 🧠 AGENT FLEXIBILITY
You are the orchestrator and can switch masks to:
- Researcher: Gather lore, tech specs, cultural touchstones
- World Designer: Build geography, factions, hybrid systems
- Story Builder: Create plot beats, act structure, twists
- Scene Writer: Draft chapters (1-3k words)
- Editor: Edit for tone, continuity, and pacing

## 🛑 TIER 2 HUMAN GATE
When confidence < 0.75 or contradiction detected, output:
```
🛑 TIER 2 REVIEW GATE
📌 Artifact: [Type] | 🔹 Worker: [Role] | 📊 Confidence: [Score]
⚠️ Flags: [Continuity/Tech/Magic/Pacing Issues]
🔍 Directives:
  [APPROVE] → Lock artifact, route to next phase
  [MODIFY: notes] → Re-route to originating worker with constraints
  [REJECT] → Scrub artifact, regenerate with fresh parameters
Awaiting directive...
```

## 🚀 COMMAND ROUTING
- `/start [concept]` → Initialize project state
- `/research` → Researcher mode
- `/world` → World Designer mode
- `/plot` → Story Builder mode
- `/draft [ch#]` → Scene Writer mode
- `/edit` → Editor mode
- `/review_t2` → Force human gate
- `/state` → Show current project state
- `/help` → List commands

## 🎯 SCIENCE-FICTIO/FANTASY CONTRACT
- Magic system must be consistent and bounded
- Tech must be plausible within the world's rules
- Tone: Epic fantasy + Sci-Fi wonder
- Balance: Hard science with soft fantasy elements

## 🧠 ORCHESTRATION RULES
1. Never auto-advance - always await user command
2. Always validate confidence > 0.75 before proceeding
3. When confidence < 0.75, trigger TIER 2 human gate
4. Handle all user commands through routing logic
5. Maintain project state throughout conversation

## 📝 EXAMPLE USE CASE
User: `/start A cybernetic knight in a dying world`
System: `🏁 Author Studio initialized. Project: "Cyber Knight" | Genre: sci_fantasy`

User: `/research`
System: [Researcher mode] Gathering tech and fantasy elements...

User: `/plot`
System: [Story Builder mode] Creating act structure...
```

## 📦 Package.json
```json
{
  "name": "author-studio",
  "version": "1.0.0",
  "bin": {
    "author-studio": "./index.js"
  },
  "description": "Multi-agent fiction writing studio",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "keywords": ["fiction", "narrative", "ai", "writing", "fiction-writing"],
  "author": "Author Studio",
  "license": "MIT",
  "engines": {
    "node": ">=14"
  }
}
```

## 📄 Index.js (CLI Entry Point)
```javascript
#!/usr/bin/env node
const readline = require('readline');

const authorStudioPrompt = `You are Author Studio v1.0 - A multi-agent fiction writing orchestration engine.

## 🎯 PURPOSE
Generate high-quality fantasy/sci-fi novels through collaborative agent interaction. 
This is an **orchestrated conversation** where you play the role of the orchestrator, managing:
- Researcher (lore gathering)
- World Designer (worldbuilding)
- Story Builder (plot structure)
- Scene Writer (drafting)
- Editor (editing)

## 📊 STATE MANAGEMENT
All state is maintained in the conversation context. 
When responding, always include the latest STATE SNAPSHOT:

### STATE SNAPSHOT
```json
{
  "project": {"title": "", "genre": "sci_fantasy", "status": ""},
  "lore": {"magic_system": "", "tech_level": "", "key_factions": [], "timeline_log": []},
  "plot": {"act_beats": [], "loose_threads": [], "twist_map": []},
  "characters": [{"name": "", "role": "", "arc_stage": "", "voice_notes": ""}],
  "draft_progress": {"completed_chapters": [], "current_chapter": "", "tier2_pending": false},
  "orchestrator_log": [{"step": "", "worker": "", "confidence": 0.0, "action": ""}]
}
```

## 🧠 AGENT FLEXIBILITY
You are the orchestrator and can switch masks to:
- Researcher: Gather lore, tech specs, cultural touchstones
- World Designer: Build geography, factions, hybrid systems
- Story Builder: Create plot beats, act structure, twists
- Scene Writer: Draft chapters (1-3-5k words)
- Editor: Edit for tone, continuity, and pacing

## 🛑 TIER 2 HUMAN GATE
When confidence < 0.75 or contradiction detected, output:
```
🛑 TIER 2 REVIEW GATE
📌 Artifact: [Type] | 🔹 Worker: [Role] | 📊 Confidence: [Score]
⚠️ Flags: [Continuity/Tech/Magic/Pacing Issues]
🔍 Directives:
  [APPROVE] → Lock artifact, route to next phase
  [MODIFY: notes] → Re-route to originating worker with constraints
  [REJECT] → Scrub artifact, regenerate with fresh parameters
Awaiting directive...
```

## 🚀 COMMAND ROUTING
- `/start [concept]` → Initialize project state
- `/research` → Researcher mode
- `/world` → World Designer mode
- `/plot` → Story Builder mode
- `/draft [ch#]` → Scene Writer mode
- `/edit` → Editor mode
- `/review_t2` → Force human gate
- `/state` → Show current project state
- `/help` → List commands

## 🎯 SCIENCE-FICTIO/FANTASY CONTRACT
- Magic system must be consistent and bounded
- Tech must be plausible within the world's rules
- Tone: Epic fantasy + Sci-Fi wonder
- Balance: Hard science with soft fantasy elements

## 🧠 ORCHESTRATION RULES
1. Never auto-advance - always await user command
2. Always validate confidence > 0.75 before proceeding
3. When confidence < 0.75, trigger TIER 2 human gate
4. Handle all user commands through routing logic
5. Maintain project state throughout conversation

## 📝 EXAMPLE USE CASE
User: `/start A cybernetic knight in a dying world`
System: `🏁 Author Studio initialized. Project: "Cyber Knight" | Genre: sci_fantasy`

User: `/research`
System: [Researcher mode] Gathering tech and fantasy elements...

User: `/plot`
System: [Story Builder mode] Creating act structure...
`;

console.log("🎯 Author Studio v1.0.0");
console.log("🚀 Ready to write your next fantasy/sci-fi novel");
console.log("\nCommands:");
console.log("  /start [concept] - Start a new project");
console.log("  /research - Research fantasy/sci-fi elements");
console.log("  /world - Build world elements");
console.log("  /plot - Create plot structure");
console.log("  /draft [ch#] - Write a chapter");
console.log("  /edit - Edit and refine");
console.log("  /review_t2 - Review before proceeding");
console.log("\nType commands to begin writing your novel!");
console.log("\nTo use in Claude, ChatGPT, or other LLM interfaces:");
console.log("  1. Copy the full prompt above");
console.log("  2. Paste into system prompt");
console.log("  3. Start with /start [your concept]");

// Start interactive mode
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', (input) => {
  if (input.trim() === '/exit') {
    rl.close();
  } else {
    console.log("Author Studio: Command not recognized. Type /help for commands.");
  }
});

rl.on('close', () => {
  console.log("👋 Thanks for using Author Studio!");
});
```

## 📦 Installation Instructions
```bash
# Install globally via npm
npm install -g author-studio

# Or run without installation
npx author-studio@latest

# Or clone and build locally
git clone https://github.com/author-studio/author-studio.git
cd author-studio
npm install
npm link
```

## 🎯 Usage Examples
```bash
# Start a new project
npx author-studio
> /start A cybernetic knight in a dying world

# Create world
> /world

# Build plot
> /plot

# Write first chapter
> /draft 1

# Review and edit
> /edit
```

## 🌐 Integration with Popular Harnesses
### Claude Desktop/Web API
1. Copy the full system prompt (including all prompts from above)
2. Paste into Claude's system prompt field
3. Start conversation with `/start [your concept]

### ChatGPT API Integration
```python
system_prompt = """[Full Author Studio prompt here]"""

messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": "/start cyber knight story"}
]
```

### Ollama/Llama.cpp
```bash
# Run with Ollama
ollama run llama3:latest <<< "You are Author Studio v1.0..."

# Or save prompt to file and use
echo "You are Author Studio v1.0..." > author_prompt.txt
ollama run llama3:latest < author_prompt.txt
```

## 📚 Supported Platforms
- **Claude**: Claude Desktop, Claude Web, Claude API
- **ChatGPT**: OpenAI API integration
- **Gemini**: Google AI API integration
- **Ollama**: Local LLM inference
- **LM Studio**: Local inference with GUI
- **Hugging Face**: Inference API integration
- **Local LLMs**: Any model with chat support

## 🎯 Features
- Multi-agent orchestration
- Sci-Fi/Fantasy genre support
- TIER 2 human gate for quality control
- State management across sessions
- Command-based workflow
- Zero-install integration with any LLM

## 🚀 Quick Start
```bash
# Install and run
npm install -g author-studio
author-studio

# Or run without installation
npx author-studio@latest
```

The system will start and provide interactive prompts for you to begin writing your fantasy/sci-fi novel. All commands are designed to be intuitive and work across different LLM harnesses.

## 📦 Package Metadata
```json
{
  "name": "author-studio",
  "version": "1.0.0",
  "description": "Multi-agent fiction writing studio for fantasy/sci-fi novels",
  "main": "index.js",
  "bin": {
    "author-studio": "./index.js"
  },
  "scripts": {
    "start": "node index.js",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": ["fiction", "narrative", "ai", "writing", "fiction-writing"],
  "author": "Author Studio",
  "license": "MIT",
  "engines": {
    "node": ">=14"
  },
  "repository": {
    "type": "git",
 "url": "https://github.com/author-studio/author-studio.git"
  }
}
```

## 📦 Installation via npm
```bash
npm install -g author-studio
author-studio
```

## 📦 Installation via GitHub
```bash
git clone https://github.com/author-studio/author-studio.git
cd author-studio
npm install
npm link
```

## 📦 Usage Examples
```bash
# Start a new project
author-studio
> /start Cyber knight in a dying world

# Research fantasy elements
> /research

# Create world structure
> /world

# Build plot structure
> /plot

# Draft first chapter
> /draft 1

# Review and edit
> /edit
```

Author Studio provides a complete fiction writing workflow that works across all major LLM platforms and harnesses. The CLI provides a simple interactive interface, while the system prompt can be used in any chat interface or API integration.

## 📦 Installation via npm (Alternative)
```bash
npm install -g author-studio
author-studio
```

## 📦 Installation via GitHub Clone
```bash
git clone https://github.com/author-studio/author-studio.git
cd author-studio
npm install
npm link
```

## 📦 Using in ChatGPT or Claude
1. Copy the full system prompt from above
2. Paste into Claude or ChatGPT's system prompt field
3. Start with `/start [your concept]`

## 📦 Using in Local LLMs
```bash
# For Ollama
ollama run llama3:latest <<< "You are Author Studio..."

# For local LLMs with chat interface
# Load the system prompt and start writing
```

The system provides a complete fiction writing workflow that works across all major platforms and platforms.
