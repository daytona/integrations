# Daytona Sandbox Plugin for OpenCode

This is an OpenCode plugin that automatically runs OpenCode sessions in Daytona sandboxes. Each session has its own remote sandbox which is automatically synced to a local git branch.

## Features

- Securely isolate each OpenCode session in a sandbox environment
- Preserves sandbox environments indefinitely until the OpenCode session is deleted
- Generates live preview links when a server starts in the sandbox
- Synchronizes each OpenCode session to a local git branch

## Usage

### Installation

To add the plugin to a project, edit `opencode.json` in the project directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@daytona/opencode"]
}
```

Now that the Daytona plugin is in the plugins list, it will automatically be downloaded when OpenCode starts.

To install the plugin globally, edit `~/.config/opencode/opencode.json`.

### Environment Configuration

This plugin requires a [Daytona account](https://www.daytona.io/) and [Daytona API key](https://app.daytona.io/dashboard/keys) to create sandboxes.

Set your Daytona API key and URL as environment variables:

```bash
export DAYTONA_API_KEY="your-api-key"
```

Or create a `.env` file in your project root:

```env
DAYTONA_API_KEY=your-api-key
```

### Running OpenCode

Before starting OpenCode, ensure that your project is a git repository:

```bash
git init
```

Now start OpenCode in your project using the OpenCode command:

```bash
opencode
```

To check that the plugin is working, type `pwd` in the chat. You should see a response like `/home/daytona/project`, and a toast notification that a new sandbox was created.

OpenCode will create new branches using the format `opencode/1`, `opencode/2`, etc. To work with these changes, use normal git commands in a separate terminal window. List branches:

```
git branch
```

Check out OpenCode's latest changes on your local system:

```
git checkout [branch]
```

To view live logs from the plugin for debugging, run this command in a separate terminal:

```bash
tail -f ~/.local/share/opencode/log/daytona.log
```

## How It Works

### File Synchronization

The plugin uses git to synchronize files between the sandbox and your local system. This happens automatically and in the background, keeping your copy of the code up-to-date without exposing your system to the agent.

#### Sandbox Setup

When a new Daytona sandbox is created:

1. The plugin looks for a git repository in the local directory. If none is found, file synchronization will be disabled.
2. A parallel repository is created in the sandbox with a single `opencode` branch, mirroring the checked out local branch.
3. A new `sandbox` remote is added to the local repository using an SSH connection to the sandbox.
4. The `HEAD` of the local repository is pushed to `opencode`, and the sandbox repository is reset to match this initial state.
5. Each sandbox is assigned a unique incrementing branch number (1, 2, 3, etc.) that persists across sessions.

#### Synchronization

Each time the agent makes changes:

1. A new commit is created in the sandbox repository on the `opencode` branch.
2. The plugin pulls the latest commits from the sandbox remote into a unique local branch named `opencode/1`, `opencode/2`, etc. This keeps both environments in sync while isolating changes from different sandboxes in separate local branches.

The plugin only synchronizes changes from the sandbox to your system. To pass local changes to the agent, commit them to a local branch, and start a new OpenCode session with that branch checked out.

> [!CAUTION]
> When changes are synchronized to local `opencode` branches, any locally made changes will be overwritten.

### Session to sandbox mapping

The plugin keeps track of which sandbox belongs to each OpenCode project using local state files. This data is stored in a separate JSON file for each project:

- On macOS: `~/.local/share/opencode/storage/daytona/[projectid].json`.
- On Windows: `%LOCALAPPDATA%\opencode\storage\daytona\[projectid].json`.

Each JSON file contains the sandbox metadata for each session in the project, including when the sandbox was created, and when it was last used.

The plugin uses [XDG Base Directory](https://specifications.freedesktop.org/basedir/latest/) specifically to resolve the path to this directory, using the convention [set by OpenCode](https://github.com/anomalyco/opencode/blob/052f887a9a7aaf79d9f1a560f9b686d59faa8348/packages/opencode/src/global/index.ts#L8).

## Development

This package lives in the [`daytona/integrations`](https://github.com/daytona/integrations) monorepo under `packages/opencode-plugin`, and is self-contained — its own `package.json`, lockfile, and dependencies (no workspace tooling).

### Setup

```bash
git clone https://github.com/daytona/integrations
cd integrations/packages/opencode-plugin
npm install
```

### Development and Testing

To modify the plugin, edit the source code files in `.opencode/plugin`.

To test the OpenCode plugin, create a test project to run OpenCode in:

```bash
mkdir ~/myproject
cd myproject
```

Add a symlink from the project directory to the plugin source code:

```
ln -s [ABSOLUTE_PATH_TO_REPO]/packages/opencode-plugin/.opencode .opencode
```

Initialize git to enable file syncing:

```
git init
```

Start OpenCode in the test project:

```bash
opencode
```

Use the instructions from [Running OpenCode](#running-opencode) above to check that the plugin is running and view live logs for debugging.

> [!NOTE]
> When developing locally with a symlink, OpenCode loads the TypeScript source directly, so no build step is required.

### Building

Build the plugin — `tsc` compiles `.opencode/plugin/**/*.ts` to `.js` + `.d.ts` in place:

```bash
npm run build
```

The published package contains the compiled `.js`/`.d.ts`; the `.ts` sources are stripped by `.npmignore`.

#### Test the built package

After building, create a test project and add a plugin file to load the built plugin (replace `[ABSOLUTE_PATH_TO_DAYTONA]` with your clone path, e.g. `/Users/you/daytona`):

```bash
mkdir -p ~/myproject && cd ~/myproject
mkdir -p .opencode/plugins
cat > .opencode/plugins/daytona-local.js << 'EOF'
module.exports = require('[ABSOLUTE_PATH_TO_REPO]/packages/opencode-plugin/.opencode/plugin')
EOF
```

Initialize git to enable file syncing, and start OpenCode:

```bash
git init
opencode
```

### Publishing

Releases are automated: merging this package's [release-please](https://github.com/googleapis/release-please) Release PR builds it and publishes the compiled package to npm (public, with provenance) from the repo's release workflow — there is no manual publish step.

## Project Structure

```
packages/opencode-plugin/
├── .opencode/plugin/              # Plugin source (TypeScript)
│   ├── daytona/                   # Main Daytona integration
│   └── index.ts                   # Plugin entry point (compiled to .js in place)
├── .gitignore
├── .npmignore
├── package.json                   # Package metadata (main/types + build script)
├── tsconfig.json                  # TypeScript config
└── README.md
```

## License

Apache-2.0
