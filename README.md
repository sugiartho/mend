# mend

One patch tool for every AI edit format.

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one written
specification, finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

- unified diffs (often with wrong line numbers)
- SEARCH/REPLACE blocks
- V4A patches
- text-editor tool calls as JSON

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new` for
a move) and `ok: <n> files`. Exit 1 lists the edits that failed and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage, missing
patch, format or parse error.

## Specification

`SPEC.md` is the whole specification: invocation, output and exit codes,
files, lines and paths, format detection, three-tier line matching, and the
four formats. The checks that score an entry are drawn from that document.

## Requirements

Node 22 and its standard library alone; nothing is installed before the
program runs. Deterministic: the same check gives the same exit code, stdout
and files every run.

## Practice

The kit carries 100 public practice checks with what the house reference did
on each. Run them with the kit's checker:

```
node check.ts <path to practice.json>
```

## License

MIT. See `LICENSE`.
