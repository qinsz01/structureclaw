/** Read provider text, excluding reasoning, images and tool-use blocks. */
export function llmContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    const item = block as Record<string, unknown>;
    return (item.type === 'text' || item.type === 'output_text') && typeof item.text === 'string' ? item.text : '';
  }).join('');
}
