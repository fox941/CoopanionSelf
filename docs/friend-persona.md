<!-- Owner: core/friend-persona.ts, core/friend/context.ts -->

# FriendPersona

FriendPersona extends CoopanionPersona and keeps its workspace, Git history, tools, heartbeat and single persistent main session. The app starts and stops the inherited heartbeat through its existing lifecycle callbacks. FriendPersona creates no background jobs or additional model clients; pausing Core therefore prevents requests using this context as well.

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

This preview verifies the integration boundary. It does not implement a database, emotions, relationships, memory retrieval, autonomous activities or controlled personality updates. The persistent state coordinator will supply `FriendContextSource` in a later change.
