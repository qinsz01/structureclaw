/** Frame coordinates, node ids and base/explicit restraints. */

export function accumulateCoords(lengths: number[]): number[] {
  const coords = [0];
  for (const value of lengths) {
    coords.push(coords[coords.length - 1] + value);
  }
  return coords;
}

export function buildBaseRestraint(baseSupport: string): boolean[] {
  return baseSupport === 'pinned'
    ? [true, true, true, false, false, false]
    : [true, true, true, true, true, true];
}

export function n2dId(storyIdx: number, bayNodeIdx: number): string {
  return `N${storyIdx}_${bayNodeIdx}`;
}

export function n3dId(storyIdx: number, xIdx: number, yIdx: number): string {
  return `N${storyIdx}_${xIdx}_${yIdx}`;
}

export function uniqueSortedCoordinates(values: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]!) > 1e-9);
}

export function coordinateIntervals(values: number[]): number[] {
  return values.slice(1).map((value, index) => value - values[index]!);
}

export function explicitFrameRestraints(
  restraints: boolean[] | undefined,
  dimension: '2d' | '3d',
): boolean[] | undefined {
  if (!restraints) return undefined;
  if (dimension === '3d' || !restraints.some(Boolean)) return [...restraints];
  const [ux, , uz, , ry] = restraints;
  if (ux && uz && ry) return [true, true, true, true, true, true];
  return [Boolean(ux), true, Boolean(uz), false, Boolean(ry), false];
}
