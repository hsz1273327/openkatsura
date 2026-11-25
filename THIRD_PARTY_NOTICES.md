# Third-Party Notices

OpenKatsura bundles or depends on open-source software components. Below is a summary of key runtime dependencies and their respective licenses (refer to each package's `LICENSE` file in `node_modules` for full text):

- **@earendil-works/pi-coding-agent**, **@earendil-works/pi-agent-core**, **@earendil-works/pi-ai** — MIT / Apache-2.0 (see upstream package metadata)
- **Electron** (`electron`) — MIT License
- **better-sqlite3** — MIT License
- **node-pty** — MIT License
- **Hono** (`hono`, `@hono/node-server`, `@hono/node-ws`) — MIT License
- **React** (`react`, `react-dom`) — MIT License
- **Zustand** (`zustand`) — MIT License
- **CodeMirror** / **TipTap** — MIT License
- **Markdown-it** / **KaTeX** / **Mermaid** — MIT License

Before distributing binaries, run a license audit (e.g., `npx license-checker --summary`) to verify no copyleft (GPL/AGPL) dependencies were introduced.
