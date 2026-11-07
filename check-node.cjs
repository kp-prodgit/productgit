// Runs before npm installs pmx, so an unsupported Node stops the install with the steps to fix it,
// instead of a pmx that fails later. Keep in step with `engines` and nodeSupported() in src/core/claude-bin.ts.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (!((major === 22 && minor >= 12) || major >= 24)) {
  console.error(`
PMX needs Node 22.12 or later (24 recommended). This is Node ${process.versions.node}, at ${process.execPath}.

1. Install Node 24: brew install node
   With nvm instead: nvm install 24 && nvm alias default 24
   (PMX's background job remembers Node's folder, so removing that nvm version later breaks it.)
2. Open a new Terminal window, and check: node -v
3. Install pmx again with the same command.
4. Run pmx init, so the background job uses the new Node.
`);
  process.exit(1);
}
