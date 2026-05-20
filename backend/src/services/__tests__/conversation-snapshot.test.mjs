import { beforeAll, describe, expect, test } from '@jest/globals';

describe('ConversationService snapshots', () => {
  let prisma;
  let ConversationService;

  beforeAll(async () => {
    const dbMod = await import('../../../dist/utils/database.js');
    const serviceMod = await import('../../../dist/services/conversation.js');
    prisma = dbMod.prisma;
    ConversationService = serviceMod.ConversationService;

    const conversationTables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'`;
    if (conversationTables.length === 0) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE conversations (
          id TEXT NOT NULL PRIMARY KEY,
          title TEXT NOT NULL,
          type TEXT NOT NULL,
          createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          modelSnapshot TEXT,
          resultSnapshot TEXT,
          latestResult TEXT
        )
      `);
    }
  }, 15000);

  test('repairs detached-house latestResult metadata before stale-coordinate checks', async () => {
    const service = new ConversationService();
    const conversationId = `conv-detached-repair-${Date.now()}`;

    await prisma.conversation.create({
      data: {
        id: conversationId,
        title: 'Detached repair',
        type: 'general',
        latestResult: {
          success: true,
          model: {
            schema_version: '2.0.0',
            nodes: [
              { id: 'N1', x: 0, y: 0, z: 0 },
              { id: 'N2', x: 0, y: 0, z: 3.6 },
            ],
            elements: [
              { id: 'C1', type: 'column', nodes: ['N1', 'N2'] },
            ],
            metadata: {
              source: 'detached_house_design',
            },
          },
        },
      },
    });

    try {
      const snapshot = await service.getConversationSnapshot(conversationId);

      expect(snapshot?.staleStructuralData).toBe(false);
      expect(snapshot?.latestResult?.model?.metadata).toEqual(expect.objectContaining({
        source: 'detached_house_design',
        coordinateSemantics: 'global-z-up',
        frameDimension: '3d',
      }));
    } finally {
      await prisma.conversation.deleteMany({ where: { id: conversationId } });
    }
  });
});
