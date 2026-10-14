const fs = require('node:fs/promises');
const { DEFAULT_BACKEND_PORT } = require('./runtime.js');

/** The CLI sends the same request as HTTP; it owns no alternate agent loop. */
async function runAgent(args, env, fetchImpl = fetch) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--request', '--url'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new Error(`Usage / 用法: sclaw run --request request.json [--url http://127.0.0.1:${DEFAULT_BACKEND_PORT}]`);
    }
    options[args[i]] = args[i + 1];
  }
  if (!options['--request']) throw new Error('REQUEST_FILE_REQUIRED / 需要请求 JSON 文件');
  const request = JSON.parse(await fs.readFile(options['--request'], 'utf8'));
  const base = new URL(options['--url'] || `http://127.0.0.1:${env.PORT || DEFAULT_BACKEND_PORT}`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_SERVER_URL');
  // No transport retry: a lost response may still own a running engineering job.
  const response = await fetchImpl(new URL('/api/v1/agent/run', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`AGENT_REQUEST_FAILED (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
module.exports = { runAgent };
