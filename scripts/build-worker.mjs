import { mkdir, writeFile } from 'node:fs/promises';

const serverDirectory = new URL('../dist/server/', import.meta.url);
const workerEntry = new URL('index.js', serverDirectory);

await mkdir(serverDirectory, { recursive: true });
await writeFile(
  workerEntry,
  `export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== 'GET') return response;

    const fallbackUrl = new URL(request.url);
    fallbackUrl.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  },
};
`,
  'utf8',
);
