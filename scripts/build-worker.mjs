import { cp, copyFile, mkdir, writeFile } from 'node:fs/promises';

const distributionDirectory = new URL('../dist/', import.meta.url);
const clientDirectory = new URL('client/', distributionDirectory);
const serverDirectory = new URL('../dist/server/', import.meta.url);
const workerEntry = new URL('index.js', serverDirectory);

// Sites maps its ASSETS binding to dist/client. Keep Vite's normal root output
// as well so `vite preview` and other static hosts continue to work unchanged.
await mkdir(clientDirectory, { recursive: true });
await copyFile(new URL('index.html', distributionDirectory), new URL('index.html', clientDirectory));
await cp(new URL('assets/', distributionDirectory), new URL('assets/', clientDirectory), { recursive: true });

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
