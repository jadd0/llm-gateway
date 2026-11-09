import type { ChatBody } from '../request-body.ts';
import type { BuildInput, BuildResult, PassthroughAdapter, Tap } from './types.ts';

// What goes upstream for a request, and how the answer's usage is read. A streamed answer only carries
// token counts if the provider is asked (stream_options.include_usage), and the counts correct the
// up-front charges. The body is changed as little as possible:
//   - the client already asked: forwarded untouched, usage read;
//   - no stream_options: the option is spliced in after the opening brace, so nothing else in the bytes
//     moves (no JSON round trip, big integers keep their precision); the usage-only chunk the client
//     did not ask for is stripped from what it receives;
//   - stream_options with include_usage not true: rewritten through JSON, usage chunk stripped;
//   - stream_options of any other shape: forwarded untouched and not reconciled (the estimate stays).
export function forwardBody(parsed: ChatBody, raw: Buffer, metered: boolean): { body: Buffer; tap: Tap } {
  if (!metered || parsed.stream !== true) return { body: raw, tap: 'none' };
  if (!('stream_options' in parsed)) {
    const open = raw.indexOf(0x7b);
    if (open < 0) return { body: raw, tap: 'none' };
    const splice = Buffer.from('"stream_options":{"include_usage":true},');
    return { body: Buffer.concat([raw.subarray(0, open + 1), splice, raw.subarray(open + 1)]), tap: 'strip' };
  }
  const so = parsed.stream_options;
  if (typeof so !== 'object' || so === null || Array.isArray(so)) return { body: raw, tap: 'none' };
  if ((so as { include_usage?: unknown }).include_usage === true) return { body: raw, tap: 'read' };
  return {
    body: Buffer.from(JSON.stringify({ ...parsed, stream_options: { ...so, include_usage: true } })),
    tap: 'strip',
  };
}

/**
 * OpenAI-format upstreams (OpenAI itself and the mock): no translation. `path` is joined to the provider's
 * base URL, which carries the version prefix as OpenAI's SDKs expect (https://api.openai.com/v1).
 */
export function createOpenAiAdapter(path = '/chat/completions'): PassthroughAdapter {
  return {
    translates: false,
    buildRequest({ body, raw, metered, apiKey }: BuildInput): BuildResult {
      const forward = forwardBody(body, raw, metered);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      return { ok: true, request: { path, headers, body: forward.body, tap: forward.tap } };
    },
  };
}
