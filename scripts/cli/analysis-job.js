const { DEFAULT_BACKEND_PORT } = require('./runtime.js');

/** Inspect or explicitly settle the existing request; never submit analysis. */
async function analysisJob(args, env, fetchImpl = fetch) {
  const [action, id, ...rest] = args;
  const usage = 'Usage / 用法: sclaw job <status|cancel|recover> <request-id> [--state-hash <inspected-hash>] [--url <server-url>]';
  if (!['status', 'cancel', 'recover'].includes(action)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new Error(usage);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--state-hash', '--url'].includes(rest[i]) || !rest[i + 1] || options[rest[i]]) throw new Error(usage);
    options[rest[i]] = rest[i + 1];
  }
  const hash = options['--state-hash'];
  if (action === 'recover' ? !/^[a-f0-9]{64}$/.test(hash || '') : hash !== undefined) throw new Error(usage);
  const base = new URL(options['--url'] || `http://127.0.0.1:${env.PORT || DEFAULT_BACKEND_PORT}`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_SERVER_URL');
  const url = new URL(`/analysis-requests/${id}${action === 'status' ? '' : '/' + action}`, base);
  const response = await fetchImpl(url, action === 'status' ? { method: 'GET' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'recover' ? { expectedStateHash: hash } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`ANALYSIS_JOB_REQUEST_FAILED (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
module.exports = { analysisJob };
