# pi-pocket-runner

The runner lets a [Pi Pocket](https://tannermidd.github.io/pi-pocket/) server run the tools of its sessions on this computer. Pi, its models, the provider keys, and the session history stay on the server. Sessions read and write files and run commands here, as your user account. Only link a server you trust.

## Install and run

Install Node.js 22.19 or newer, then run:

```sh
npm install -g pi-pocket-runner
pi-pocket-runner
```

In a terminal, `pi-pocket-runner` opens a menu: link this computer with a code from the server (Menu → **Runners** → **Link a computer**), then start. Where Pi Pocket is installed with its runner, `pi-pocket runner` runs the same code.

The commands, the service, and what a session can do here are in Pi Pocket's [docs/runners.md](https://github.com/TannerMidd/pi-pocket/blob/main/docs/runners.md).

## How it runs

The runner is TypeScript with no build step. Node strips the types. Node does not strip types under a `node_modules` folder, so the package has its own hook for that (`bin/strip-types.js`). The command (`bin/pi-pocket-runner.js`) and the entry (`main.js`) load the hook first.

## Check and test

From the root of the Pi Pocket repository, after `npm ci`:

```sh
npm run check --workspace pi-pocket-runner
npm test --workspace pi-pocket-runner
```

## Its version

The runner has its own version, in its `package.json`. It sends this version to the server when it connects. The server shows it on the computer's card in **Runners**.

## Files that exist twice

The runner and Pi Pocket's server do not import each other. Each side keeps its own copy of the files that both need. The two copies are the same bytes:

| In the runner             | In Pi Pocket                              |
| ------------------------- | ----------------------------------------- |
| `src/protocol.ts`         | `src/server/runner-link/protocol.ts`      |
| `src/secure-link.ts`      | `src/server/runner-link/secure-link.ts`   |
| `src/tunnels.ts`          | `src/server/runner-link/tunnels.ts`       |
| `src/transport.ts`        | `src/server/runner-link/transport.ts`     |
| `src/read-snapshot.ts`    | `src/server/runner-link/read-snapshot.ts` |
| `src/folders.ts`          | `src/server/runner-link/folders.ts`       |
| `src/pi-session-files.ts` | `src/server/pi-session-files.ts`          |
| `bin/strip-types.js`      | `bin/strip-types.js`                      |

Pi Pocket's `test/runner-copies.test.ts` fails when a pair differs. Copy the file you changed over the other. When the link between a server and a runner changes, also raise `LINK_PROTOCOL` in `protocol.ts`.

## Release order

Release the runner first, then Pi Pocket. Pi Pocket pins the runner's version in its `optionalDependencies`, and **Runners** shows the install command for that version. Pi Pocket's `test/runner-boundary.test.ts` checks that the pin is the version in this folder.

The `Runner` workflow (`.github/workflows/runner.yml`) checks and packs the runner. For a published release, it attaches the tarball to the release. It does not publish to npm yet.

## Moving to its own repository

The runner can move to its own repository:

1. Copy this folder to the new repository.
2. Move `.github/workflows/runner.yml` there, and change its paths.
3. Remove `packages/runner` from Pi Pocket's `workspaces`.

Then these change too:

- Pi Pocket's own tests that start a real runner (`test/runner.test.ts`, `test/remote-*.test.ts`, and others) import this folder by path. They must get the runner another way, such as the installed package.
- The test that compares the copies (`test/runner-copies.test.ts`) needs the other repository, to read its files.
