<!-- Owner: core/friend/memory-service.ts, core/friend/memory-index.ts, core/friend/memory-tools.ts, core/friend-persona.ts -->

# Managed companion memory

FriendPersona records newly delivered desktop chat and speech as source envelopes before the model turn. Cortico retains the original events; envelopes carry its cursor, event time, type and received text. Duplicate delivery uses the same source key. Recording a statement establishes what was received; its contents are not certified as true.

The character chooses what to remember through `friend_memory_save` during its normal turn. This adds no extra model client or extraction call. Instructions distinguish statements, observations, reflections, inferences, fiction and commitments, and identify whether each memory concerns the owner, the character or someone else. Semantic classification still depends on model judgment. Evidence ids and current parent revisions are checked mechanically.

## Files and authority

```
<runtime>/
  friend/
    friend.sqlite
    memory/
      .git/
      entries/<memory-id>/<revision>.md
  home/companion/workspace/
    CONSTITUTION.md
    SYSTEM.md
```

Managed documents use a separate directory and Git repository under the same runtime. Workspace file tools cannot bypass their managed APIs. The assembly supplies the existing WorkspaceGit implementation from staged Cortico; production imports no runtime code from the developer's submodule checkout. The ordinary workspace keeps character-authored prompts and free-form notes. Existing files are preserved and are not automatically imported.

Published Markdown revisions are authoritative memory bodies. SQLite owns ids, scope, revision, status, evidence, derivation links, publication progress and the derived search index. A pending document stays in the journal until its file is verified. Reads check SHA-256; a missing or changed document fails rather than serving a different version. Operator edits to published files require reconciliation; normal revisions use the memory tools.

## Publication and corrections

A write commits metadata, evidence, derivations and the pending document in one SQL transaction. It removes the previous search entry and marks current dependent memories stale, recursively. The service writes and syncs a temporary file, renames it to its immutable revision path, verifies the hash, then publishes the index. Only then is the pending body cleared. SQL transactions contain no model or Git work.

Writes and Git commits are serialized. A stable tool-call key returns the original receipt on redelivery and rejects different content under that key. Revision checks reject obsolete edits. Repeating an old receipt cannot restore an old memory as current. Failed document writes stay pending and absent from recall. Startup retries publication, accepts matching files and preserves conflicting files for inspection. Git failure is reported separately in the receipt; Markdown revisions remain saved, and startup or a retry attempts to commit them. Git is optional in the storage service and supplied by the app.

Corrections revise the same id. Explicit historical reads retain old revisions. Retraction removes a memory from current search while preserving history. Dependent summaries need reassessment after a correction. Derivations cannot cycle, refer to inaccessible or obsolete parents, or promote a fiction-classified parent into a non-fiction memory. These checks do not prove newly generated claims are correct.

## Tools and retrieval

| Tool | Contract |
| --- | --- |
| `friend_memory_sources` | Up to eight recent accessible source excerpts |
| `friend_memory_source` | Original evidence by id, paged in 4000-character slices, with its Cortico cursor |
| `friend_memory_save` | Create, revise or retract a memory with evidence or current parents |
| `friend_memory_search` | Current published memories matching keywords, within a character budget |
| `friend_memory_read` | Verified Markdown and metadata; an explicit revision reads historical content |

Each request gets up to three recent source excerpts and at most 3500 characters of related memory JSON in its local head. The latest desktop message supplies the query; after startup, the latest recorded source supplies it. The head is not appended to persistent history or handoff notes. Tools can retrieve other topics. FTS5 uses ICU words and adjacent Han pairs, title weighting and bounded output. This is lexical fallback retrieval: synonym and semantic recall are not implemented or evaluated. No vector model is required.

## Scopes and current limits

The host selects read scopes and the destination scope. Tool arguments cannot choose them. Source reads, document reads and search check scope; private evidence and parents cannot be published into a broader scope. Only the main session has access, and writes require a host call id.

This release connects desktop owner chat and speech. Other Worlds disable managed memory access until a recognized desktop message restores it. QQ and groups still require trusted identity binding and separate conversations/prefixes. Memory-tool scope checks alone do not isolate an existing main session or its workspace and are not a complete multi-user privacy boundary. General computer/file access has independent permissions.

Aggregate counts and directory information appear in `/api/status.friendStorage.memory`. Shutdown drains queued writes before closing storage. Schema 2 upgrades existing data in place. Back up and move the complete stopped runtime, including `friend/memory`, its Git history, workspace and Cortico records. Database-only snapshots omit published memory bodies.

Nightly consolidation, temperature tiers, emotion dynamics, autonomous activities, old-conversation backfill and automatic note import remain separate work. No personality or emotional defaults are initialized. Isolated tests exercise real SQLite, files, Git and Core delivery/dispatch, with only model responses scripted. Process interruption tests do not establish power-loss tolerance or long-term recall quality.
