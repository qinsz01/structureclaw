import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let visionModel;
jest.unstable_mockModule('../../../dist/utils/llm.js', () => ({ createVisionChatModel: () => visionModel }));
const { summarizeImageAttachment, summarizeFileImages } = await import('../../../dist/agent-langgraph/attachment-vision.js');
const attachment = { fileId: 'image', originalName: 'beam.png', relPath: 'beam.png' };
const image = 'data:image/png;base64,aW1hZ2U=';
beforeEach(() => { visionModel = null; });

describe('vision failures do not become missing-data success', () => {
  test('missing model stops before an interpretation is returned', async () => {
    await expect(summarizeImageAttachment(attachment, image, 'Read the beam.', 'en'))
      .rejects.toThrow('VISION_MODEL_REQUIRED');
  });

  test.each(['', 'not-json', '{}'])('invalid vision response %j stops the operation', async content => {
    visionModel = { invoke: jest.fn(async () => ({ content })) };
    await expect(summarizeImageAttachment(attachment, image, 'Read the beam.', 'zh'))
      .rejects.toThrow('VISION_MODEL_FAILED');
    expect(visionModel.invoke).toHaveBeenCalledTimes(1);
  });

  test('an upstream failure cannot produce completed image analysis', async () => {
    visionModel = { invoke: jest.fn(async () => { throw new Error('provider unavailable'); }) };
    const source = { type: 'image', base64DataUri: image };
    await expect(summarizeFileImages(source, 'beam.png', 'en', 'Read it.')).rejects.toThrow('VISION_MODEL_FAILED');
    expect(source).not.toHaveProperty('visionStatus');
    expect(visionModel.invoke).toHaveBeenCalledTimes(1);
  });

  test('cancellation propagates without an unavailable-image substitute', async () => {
    const controller = new AbortController();
    visionModel = { invoke: jest.fn(async () => { controller.abort(new Error('cancelled')); throw new Error('cancelled'); }) };
    await expect(summarizeImageAttachment(attachment, image, 'Read it.', 'en', controller.signal)).rejects.toThrow('cancelled');
  });
});
