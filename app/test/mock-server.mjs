// A tiny scriptable HTTP server for provider and end-to-end tests.
import http from 'node:http';

export async function startServer(routes) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Keep the raw body.
    }
    const url = new URL(req.url, 'http://localhost');
    const entry = { method: req.method, path: url.pathname, search: url.search, headers: req.headers, body };
    requests.push(entry);
    const route = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `No route for ${req.method} ${url.pathname}` } }));
      return;
    }
    try {
      await route(req, res, entry, requests);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

export function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Writes Server-Sent Events, optionally splitting the bytes awkwardly.
export async function sse(res, events, { split = 0, delay = 0, newline = '\n' } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const text = events
    .map((event) => {
      if (typeof event === 'string') return `${event}${newline}${newline}`;
      const lines = [];
      if (event.event) lines.push(`event: ${event.event}`);
      lines.push(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}`);
      return `${lines.join(newline)}${newline}${newline}`;
    })
    .join('');
  if (!split) {
    res.write(text);
  } else {
    for (let index = 0; index < text.length; index += split) {
      res.write(text.slice(index, index + split));
      if (delay) await pause(delay);
    }
  }
  res.end();
}

export function anthropicEvents(parts, stopReason = 'end_turn') {
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    ...parts.map((text) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

export function openaiEvents(parts, finishReason = 'stop') {
  return [
    { data: { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
    ...parts.map((content) => ({ data: { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] } })),
    { data: { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] } },
    { data: '[DONE]' },
  ];
}
