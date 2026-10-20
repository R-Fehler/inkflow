# inkflow-editor

A visual editor for [inkflow](https://github.com/ll-nick/inkflow) decks, and
the commands an agent (Claude Code) uses to work on a deck beside its author.

It is an inkflow **plugin**: it imports inkflow as a library and adds to it,
and inkflow itself knows nothing about it. Installed next to inkflow, it adds

- `inkflow edit`: the editor at `/edit` of the deck's server (click, drag and
  type on your slides; every change is written straight back to the deck's
  own files: slide SVGs, Markdown, `deck.py`);
- the agent commands: `inkflow slide`, `shape`, `anim`, `layout`, `overlay`,
  `find`/`replace`, `mv`, `files`, `outline`, `context`, `goto`, `select`,
  `comments`, `compare`, `worktree`, `setup-claude`;
- `inkflow pack`, `fonts bundle`/`set`, `relay`, `setup-desktop`;
- `inkflow verify` lines for arrows whose shapes moved and for what ties a
  deck to one machine.

```bash
pip install inkflow-editor      # pulls in inkflow
inkflow edit --deck deck.py
```

See [CLAUDE.md](CLAUDE.md) for how it is built on the core's plugin and
server-extension APIs.
