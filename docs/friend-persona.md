<!-- Owner: core/friend-persona.ts, core/friend/context.ts -->

# FriendPersona

FriendPersona extends CoopanionPersona and keeps its workspace, Git history, tools, heartbeat and single persistent main session. The app starts and stops the inherited heartbeat through its existing lifecycle callbacks. FriendPersona creates no background jobs or additional model clients; pausing Core therefore prevents requests using this context as well.

## Self-authored character

New characters start with empty `CONSTITUTION.md` and `SYSTEM.md` in their workspace. The former is their self-description; the latter supplies their personal system instructions through the existing System prompt page. The character can edit both with workspace tools, including clearing their contents. The files themselves remain in place. Language changes and restarts preserve authored contents and never restore a shipped personality.

Successful changes to these files or `PARTNER.md` request a system-prefix rebuild at Core's next safe batch boundary. The tool does not wait on that rebuild, which would deadlock a running batch. Workspace Git records successful edits as before; the rebuild preserves conversation history. The prompt page continues to support operator edits and its existing apply action.

The application retains a separate runtime segment for file locations, persistence and tool mechanics. It assigns no personality, emotional disposition, identity or relationship. Desktop expressions and display names describe interface state. They are not evidence of the character's emotions. The shipped personality introduction is not run, and its menu entry opens settings. A fresh session waits for input rather than starting a model turn from an opening notice.

First-turn examples use the workspace files `FIRST_TURN_USER.md`, `FIRST_TURN_THINKING.md` and `FIRST_TURN_REPLY.md`, when explicitly provided and enabled. No examples are seeded. Previous deployment-side prompt overrides are not used by FriendPersona. Resetting an existing character's conversation and memory is a separate explicit operation; seeding does not erase existing data.

To retain an existing deployment's personal instructions during an upgrade, copy their desired content from `prompts/ORIENTATION.md` into `workspace/SYSTEM.md` and move any desired first-turn examples into the workspace. Existing `CONSTITUTION.md` is preserved. An explicit blank reset discards these old instructions and examples instead.

Each model request reads `FriendContextSource` through Cortico's `sessionHead()`. A snapshot is `{ revision: number, content: string }`, with at most 4096 characters of content. The added item is request context, so it is neither appended to persistent chat history nor retained in handoff notes. Its ID and text remain stable while its source is unchanged. Existing first-turn examples stay in the head.

## Development preview

The initial source reads `<deployment>/friend/context-preview.json` only when the process environment contains `COOPANION_FRIEND_ENABLED=1`. This is off by default. The file is outside the model's workspace, is never created automatically, and is limited to 32 KiB. Its revision must be a nonnegative safe integer and its content must be nonempty. Changes are read on the next request.

```json
{
  "revision": 1,
  "content": "Development preview: energy is low. This is synthetic test input, not a persistent emotional state."
}
```

An absent file contributes no context. An invalid source is omitted for that request and logged; the base chat context remains available. Setting the environment variable to `0` or leaving it unset disables the added context. Restart the process after changing its environment.

For the local development profile, the deployment is `D:\ai friend\runtime\dev\home\companion`. Its model credentials, character files and chat history are independent of this preview. Do not commit runtime files.

This preview verifies the state context boundary. The app opens [persistent companion storage](friend-storage.md) during startup; that store initially contains an empty state and stable character ID. It is independent of the preview and does not yet supply `FriendContextSource`. [Managed memory](friend-memory.md) has a separate source, tool and request-context path: desktop delivery records evidence, the character chooses memory writes, and each request recalls related current documents. Its Markdown repository is outside the ordinary workspace. Learned emotional state, relationships, autonomous activities and nightly reflection remain to be implemented. No emotional preset is initialized.
