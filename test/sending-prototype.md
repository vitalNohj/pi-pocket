# Sending row prototype

**Throwaway UI. Do not merge or deploy this branch.** It asks what a send should look like while the message is not yet in history. The default is a bubble that shows what you sent. No design has been selected for release.

From this worktree, with dependencies installed:

```sh
npm run preview:sending
```

Open the two links printed in the terminal: sign in to the scratch app, then open the Launch checklist session. The instance uses a temporary data folder and a scripted model. It listens only on `127.0.0.9:8897`, with no connection to the live service or its data. Stop it with Ctrl+C.

- Send any sample message, in the session, floating PiP, or PiP on its Board. Open PiP with Alt+A, and use Appearance to switch between Floating and Board.
- Compare **Message bubble**, **Compact outbox**, and **Delivery marker** with the arrows. Their URL values are `?prototype=sending&variant=bubble`, `outbox`, and `marker`.
- **Deliver** lets the request reach the scratch server. The preview stays until the transcript or waiting strip shows the accepted message. **Refuse** simulates a refusal and returns PiP's words to the box.

The pending row is local to the tab. The prototype assumes one sender; a release must match the exact submission to its history entry and handle reconnects and ambiguous failures.
