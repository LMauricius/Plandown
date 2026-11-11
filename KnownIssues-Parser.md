# Known issues: Parser

## Generic code fences close too eagerly

`parseMarkdown` in `src/markdown.ts` ends an ordinary fenced code block at any line starting with the same three characters (`FENCE` matches only the first three backticks or tildes). CommonMark requires the closing fence to be at least as long as the opening one and to carry no info string. A ```` ```` ```` fence that wraps a ```` ``` ```` example therefore ends at the inner fence, and a line like ```` ```js ```` inside a block closes it. Headings and task bullets after that point are then misread. Property blocks are not affected; they use the stricter closing rule in `propsAt`. Fix: track the opening run's character and length, and accept only a bare run at least as long as the closer. Note that `reshape` in `src/edit.ts` has the same fence logic.
