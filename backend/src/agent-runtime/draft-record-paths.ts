/** Diagnostic paths identify a stable object or an original array index; never a patch offset. */
export function draftRecordPaths(collection: string, id: unknown, index: number): string[] {
  const paths = [`${collection}[${index}]`];
  if (typeof id !== 'string' || !id) return paths;
  paths.push(`${collection}.${id}`, `${collection}[${JSON.stringify(id)}]`);
  if (!/[[\]'"\\]/.test(id)) {
    paths.push(`${collection}['${id}']`);
    // An unquoted numeric selector always means an array index, even when an ID is numeric.
    if (!/^\d+$/.test(id)) paths.push(`${collection}[${id}]`);
  }
  return paths;
}
