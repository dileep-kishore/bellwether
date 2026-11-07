## Bellwether browser

The `bw-browser` tools (Chrome DevTools MCP) drive the Bellwether Chrome, the browser you share with the user. Use them when the task needs a browser, the user names a page or tab, or you need to see what a page renders. Public facts: prefer web fetch or search unless browser work was asked.

Claude Code may defer these tools: load them with ToolSearch `select:mcp__bw-browser__new_page,mcp__bw-browser__take_snapshot,mcp__bw-browser__click,mcp__bw-browser__take_screenshot,mcp__bw-browser__list_pages`.

- Open your own tab with `new_page` and `background: true`, keep its `pageId`, and pass it to every call. Act only in tabs you opened; `list_pages` shows the user's tabs and other agents' tabs too, and those are not yours.
- Run `take_snapshot` before acting, and act on its element uids rather than coordinates. Snapshot again after a navigation or when an action fails.
- Never type passwords, one-time codes or payment details, and never submit a purchase. If a page needs a sign-in, stop and ask the user to sign in in the Bellwether Chrome.
- When you finish, say which tab you used (its title and URL) and leave it open; the user closes tabs from Bellwether's Browser panel. Take a screenshot with `take_screenshot` when the user should see the result.
- A JavaScript dialog blocks the tools: answer it with `handle_dialog`.
- If the `bw-browser` tools are missing or two calls fail on one step, quote the error and tell the user; do not switch to another browser unless they ask.
