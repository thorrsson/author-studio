# Repository instructions

Use Conventional Commits for commit messages because Release Please relies on
them to determine desktop version bumps and generate release notes:

- `fix:` for a patch release.
- `feat:` for a minor release.
- Add `!` after the type/scope, or a `BREAKING CHANGE:` footer, for a major
  release.
- Use other Conventional Commit types, such as `docs:`, `test:`, and `chore:`,
  for changes that should not trigger a release by themselves.

Examples: `fix: preserve imported project metadata`,
`feat(app): add project search`, and
`feat!: replace the project state format`.
