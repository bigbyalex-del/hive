// OpenAI provider — implements the same agent loop (text + tool-use) so any
// agent can be configured to run on GPT models instead of Claude.
//
// Requires `npm i openai` (added to package.json in v0.2).

import * as fs from 'fs/promises';
import * as path from 'path';
import { Provider, RunOptions, RunResult, RunEvents, ToolDef } from './types';

// Lazy-load the SDK so the app boots without it installed. The `new Function`
// wrapper prevents TypeScript from transpiling import() to require() under
// CommonJS — same trick as the Anthropic provider.
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

async function getOpenAI() {
  try {
    const mod = await dynamicImport('openai');
    const Ctor = mod.default ?? mod.OpenAI;
    return new Ctor({ apiKey: process.env.OPENAI_API_KEY });
  } catch (err: any) {
    throw new Error(`openai package: ${err?.message ?? err}`);
  }
}

// Built-in file tools mirroring the ones the Anthropic SDK provides for free,
// so workers running on GPT have the same capability surface.
function builtInTools(cwd: string): ToolDef[] {
  const safe = (p: string) => {
    const abs = path.resolve(cwd, p);
    if (!abs.startsWith(path.resolve(cwd))) throw new Error('path outside cwd');
    return abs;
  };

  return [
    {
      name: 'Read',
      description: 'Read a file from the agent worktree.',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async ({ path: p }) => {
        return await fs.readFile(safe(p), 'utf8');
      },
    },
    {
      name: 'Write',
      description: 'Write (overwrite) a file in the agent worktree.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      run: async ({ path: p, content }) => {
        const abs = safe(p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
        return `wrote ${p} (${content.length} bytes)`;
      },
    },
    {
      name: 'Edit',
      description: 'Replace one occurrence of old_string with new_string.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      run: async ({ path: p, old_string, new_string }) => {
        const abs = safe(p);
        const cur = await fs.readFile(abs, 'utf8');
        if (!cur.includes(old_string)) throw new Error('old_string not found');
        await fs.writeFile(abs, cur.replace(old_string, new_string), 'utf8');
        return `edited ${p}`;
      },
    },
    {
      name: 'Glob',
      description: 'List files matching a glob pattern in the worktree.',
      schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      run: async ({ pattern }) => {
        // Minimal glob — recursive walk, filter by simple suffix/prefix.
        const out: string[] = [];
        async function walk(dir: string) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else out.push(path.relative(cwd, full));
          }
        }
        await walk(cwd);
        const rx = new RegExp(pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'));
        return out.filter(f => rx.test(f)).join('\n') || '(no matches)';
      },
    },
  ];
}

export class OpenAIProvider implements Provider {
  name = 'openai' as const;
  models = ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini'];

  async run(model: string, opts: RunOptions, events: RunEvents): Promise<RunResult> {
    const client = await getOpenAI();
    const tools = opts.tools ?? (opts.cwd ? builtInTools(opts.cwd) : []);

    const messages: any[] = [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.prompt },
    ];

    const toolDefs = tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));

    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    let finalText = '';

    const maxTurns = opts.maxTurns ?? 8;

    for (let turn = 0; turn < maxTurns; turn++) {
      turns++;
      const resp = await client.chat.completions.create({
        model,
        messages,
        tools: toolDefs.length ? toolDefs : undefined,
      });
      const msg = resp.choices[0].message;
      inputTokens += resp.usage?.prompt_tokens ?? 0;
      outputTokens += resp.usage?.completion_tokens ?? 0;

      messages.push(msg);

      if (msg.tool_calls?.length) {
        for (const call of msg.tool_calls) {
          const tool = tools.find(t => t.name === call.function.name);
          let result = '';
          let input: any = {};
          try {
            input = JSON.parse(call.function.arguments || '{}');
            events.onToolCall?.(call.function.name, input);
            result = tool ? await tool.run(input) : `unknown tool: ${call.function.name}`;
            events.onToolResult?.(call.function.name, result.slice(0, 200));
          } catch (e: any) {
            result = `error: ${e.message}`;
            events.onError?.(e);
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        continue; // next turn so the model can react to tool results
      }

      if (msg.content) {
        finalText = msg.content;
        events.onText?.(msg.content);
      }
      break; // no tool calls = final answer
    }

    return { text: finalText.trim(), inputTokens, outputTokens, turns };
  }
}
