/** Model tools use a host-selected scope and stable tool-call receipts. */
import type { ToolDef } from 'cortico/core/types.ts';
import type { MemoryAccess, MemoryInput, MemoryService } from './memory-service.ts';

export function memoryTools(service: () => MemoryService | null, access: () => MemoryAccess | null): ToolDef[] {
  const definitions: Array<Omit<ToolDef, 'handler'> & { run: (memory: MemoryService, scope: MemoryAccess, args: Record<string, unknown>, callId?: string) => unknown }> = [
    {
      name: 'friend_memory_source', tags: ['read'],
      description: 'Inspect the original statement behind a memory evidence id, including its time and Cortico cursor. Use offset to continue after a clipped 4000-character slice.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['id'] },
      run: (memory, scope, args) => memory.source(scope, String(args.id ?? ''), args.offset === undefined ? 0 : Number(args.offset)),
    },
    {
      name: 'friend_memory_sources', tags: ['read'],
      description: 'Read recent accessible source statements and their evidence ids. A statement records what was received; it is not automatically a verified fact.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 8 } } },
      run: (memory, scope, args) => memory.sources(scope, args.limit === undefined ? 8 : Number(args.limit)),
    },
    {
      name: 'friend_memory_search', tags: ['read'],
      description: 'Retrieve relevant current memories by Chinese or other keywords. Results retain subject, classification and evidence. Empty results do not establish that something never happened.',
      parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 512 }, max_chars: { type: 'integer', minimum: 512, maximum: 8000 } }, required: ['query'] },
      run: (memory, scope, args) => memory.search(scope, String(args.query ?? ''), args.max_chars === undefined ? 4096 : Number(args.max_chars)),
    },
    {
      name: 'friend_memory_read', tags: ['read'],
      description: 'Read a managed Markdown memory and its evidence. An explicit revision reads historical content; check the current status before relying on it. Stale memories need reassessment.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 } }, required: ['id'] },
      run: (memory, scope, args) => memory.read(scope, String(args.id ?? ''), args.revision === undefined ? undefined : Number(args.revision)),
    },
    {
      name: 'friend_memory_save', tags: ['write'],
      description: 'Remember an experience, statement, thought or commitment with evidence. Keep who it concerns separate from who said it. Revise an existing id with its expected_revision when correcting it; dependent summaries become stale. Retract a current memory with status retracted. Recording a thought does not change your personality documents.',
      parameters: {
        type: 'object', properties: {
          title: { type: 'string', maxLength: 160 }, text: { type: 'string', maxLength: 8000 },
          kind: { type: 'string', enum: ['statement', 'observation', 'reflection', 'inference', 'fiction', 'commitment'] },
          subject: { type: 'string', enum: ['owner', 'self', 'other'] },
          source_ids: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          parents: { type: 'array', maxItems: 16, items: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 } }, required: ['id', 'revision'] } },
          id: { type: 'string' }, expected_revision: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['active', 'retracted'] },
        }, required: ['title', 'text', 'kind', 'subject', 'source_ids'],
      },
      run: (memory, scope, args, callId) => {
        if (!callId) throw new Error('A host tool-call id is required to record memory.');
        return memory.save(scope, {
          requestKey: `main:${callId}`, title: args.title, text: args.text, kind: args.kind, subject: args.subject,
          sourceIds: args.source_ids, parents: args.parents, id: args.id, expectedRevision: args.expected_revision, status: args.status,
        } as MemoryInput);
      },
    },
  ];
  return definitions.map(({ run, ...definition }) => ({ ...definition, handler: async (args, ctx) => {
    try {
      if (ctx.role !== 'main') throw new Error('Managed memory is available only to the main character session.');
      const memory = service();
      const scope = access();
      if (!memory || !scope) throw new Error('Managed memory is unavailable in this conversation.');
      return JSON.stringify(await run(memory, scope, args, ctx.callId));
    } catch (error) {
      return { text: JSON.stringify({ error: error instanceof Error ? error.message : 'Memory operation failed.' }), failed: true };
    }
  } }));
}
