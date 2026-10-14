import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previous = process.env.SCLAW_DATA_DIR;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-public-files-'));
process.env.SCLAW_DATA_DIR = temporary;
const summarize = jest.fn(async analysis => ({ ...analysis, visionStatus: 'completed',
  inputEvidence: [{ id: 'image-support', field: 'nodes.N1.restraints', status: 'missing', required: true,
    source: { file: 'support.png', region: [0, 0, 0.5, 0.5] } }] }));
jest.unstable_mockModule('../../../dist/agent-langgraph/attachment-vision.js', () => ({
  summarizeFileImages: summarize, summarizeImageAttachment: jest.fn(),
}));
const { createPublicToolSession } = await import('../../../dist/agent-langgraph/public-tool-contracts.js');
const directory = path.join(temporary, '.uploads', 'trusted-host');
fs.mkdirSync(directory, { recursive: true });
const image = path.join(directory, 'support.png');
fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ukAAAAASUVORK5CYII=', 'base64'));
const policy = { skillIds: [], tools: { enabledIds: ['analyze_file'] } };
beforeEach(() => summarize.mockClear());
afterAll(() => {
  if (previous === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = previous;
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('public attachment permissions and shared vision entry', () => {
  test('an ungranted upload cannot trigger parsing or vision', async () => {
    const session = await createPublicToolSession({ runPolicy: policy });
    const result = await session.invoke('analyze_file', { filePath: image });
    expect(JSON.stringify(result.messages)).toContain('restricted to the attachments');
    expect(summarize).not.toHaveBeenCalled();
  });
  test.each(['zh', 'en'])('granted image uses the same localized, bounded vision callback (%s)', async locale => {
    const message = locale === 'zh' ? '复核左支座' : 'Review the left support';
    const session = await createPublicToolSession({ runPolicy: policy, attachmentPaths: [image], locale, message });
    const args = { filePath: image, region: [0, 0, 0.5, 0.5], requiredFields: ['nodes.N1.restraints'] };
    const result = await session.invoke('analyze_file', args);
    expect(summarize).toHaveBeenCalledTimes(1);
    const [analysis, filePath, actualLocale, actualMessage] = summarize.mock.calls[0];
    expect(analysis.visionRequest).toEqual({ region: args.region, requiredFields: args.requiredFields });
    expect(analysis.base64DataUri).toMatch(/^data:image\/png;base64,/);
    expect([filePath, actualLocale, actualMessage]).toEqual([image, locale, message]);
    expect(JSON.stringify(result.messages)).not.toContain('data:image/png;base64,');
    expect(result.state.inputEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'image-support', required: true })]));
    const resumed = await createPublicToolSession({ sessionId: session.sessionId, resume: true });
    await resumed.invoke('analyze_file', args);
    expect(summarize).toHaveBeenCalledTimes(2);
    await expect(createPublicToolSession({ sessionId: session.sessionId, resume: true, attachmentPaths: [] }))
      .rejects.toThrow('PUBLIC_SESSION_RESUME_IMMUTABLE');
    const newTurn = await createPublicToolSession({ sessionId: session.sessionId, newTurn: true, message: 'No attachments' });
    await newTurn.invoke('analyze_file', args);
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});
