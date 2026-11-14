# Question bank

One folder per topic, one markdown file per question. The folder names match the `mix` of the rounds in
`config.json` (or the built-in rounds when `config.json` has none).

- `# Title` is the question the agent asks (text in brackets at the end is dropped).
- `## Short Answer` is what a strong answer covers. The live agent reads only this part, to judge
  answers and pick follow ups. Keep it to a few lines.
- Anything after it (deep dive, examples) is read by the grader when it scores the answer.
- `**Priority:**` is optional: `1` must know, `2` common (the default), `3` advanced.
- Files and folders starting with `_`, and READMEs, are notes, not questions.
- A round with `"only": "design-"` uses only files with `design-` in the name.
