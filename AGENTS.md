# Rules

Do not modify these rules or the Vite+ instructions unless explicitly asked to do so.

- After each completed logical change, commit and push the changes.
- Commit messages must follow the Conventional Commits format, be single-line only and not include descriptions
- Never add yourself as a co-author, co-contributor, or contributor in commits or repository metadata.

- Keep comments rare and concise; use them only for non-obvious constraints, intent, or workarounds, never to narrate self-explanatory code.

- pnpm is the only package manager permitted for this project.
- Do not use npm, yarn, Bun, or any other package manager.
- Package-management operations must go through Vite+ (`vp`) unless explicitly stated otherwise.
- Do not invoke `pnpm` directly for normal package-management operations.
- Do not use `npx`; use `pnpm dlx` for one-off CLI execution when necessary.
- `pnpm dlx` is the only permitted exception to the rule against invoking `pnpm` directly.
- Never manually edit the lockfile; dependency changes must be performed through Vite+.

- Always use the latest stable version of dependencies, tools, and frameworks unless explicitly instructed otherwise.
- Never downgrade, pin to an older version, or roll back a dependency to work around an error without explicit permission.
- Resolve compatibility issues while remaining on current versions whenever possible.
- Use only the latest Node.js LTS release.

- Do not bypass Vite+ checks, disable linting/type checking, or remove tests to make validation pass.
- Before committing, run all applicable validation checks described in the Review Checklist and resolve any failures caused by your changes.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
