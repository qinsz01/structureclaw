// Operator entry only. Deliberately not registered as an agent tool: an agent
// must not manufacture a new turn to reset an exhausted application budget.
import fs from 'node:fs';
import { resolveOptions, invokeWorker } from './bridge.mjs';

try {
  const args = process.argv.slice(2);
  const values = {};
  if (args.length % 2) throw new Error('INVALID_ARGUMENTS / 参数需成对提供');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--config', '--session', '--message', '--message-file'].includes(key) || values[key] !== undefined) {
      throw new Error(`INVALID_ARGUMENT: ${key} / 无效或重复参数`);
    }
    values[key] = args[index + 1];
  }
  if (!values['--config'] || !values['--session'] || Boolean(values['--message']) === Boolean(values['--message-file'])) {
    throw new Error('Usage / 用法: node manage-session.mjs --config plugin-config.json --session <sessionId> --message <new user request> (or --message-file request.txt)');
  }
  const options = resolveOptions(JSON.parse(fs.readFileSync(values['--config'], 'utf8')));
  const message = values['--message-file'] ? fs.readFileSync(values['--message-file'], 'utf8') : values['--message'];
  if (!message.trim()) throw new Error('USER_MESSAGE_REQUIRED / 需要新用户要求');
  // Confirm this is an existing engineering session; an operator typo must not
  // create another conversation under an arbitrary supplied identifier.
  await invokeWorker(options, { action: 'inspect', sessionId: values['--session'] });
  const result = await invokeWorker(options, { action: 'new_turn', sessionId: values['--session'], args: { message } });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
