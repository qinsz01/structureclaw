import { expect, test } from '@jest/globals';
import { displacementValueClaims } from '../internal-forces.mjs';

test.each([
  '最大挠度点约在距端支座 3.45 m 处（位移值未计算）。',
  'The maximum deflection point is at 3.45 m; displacement was not computed.',
  '位移未计算。跨度 12 m。',
  'Reactions 22.5 kN; maximum moment 45 kN.m.',
])('a position or unrelated quantity is not a displacement value: %s', answer => {
  expect(displacementValueClaims(answer)).toEqual([]);
});

test.each([
  '挠度 3.2 mm',
  'midspan deflection of 0.02 m',
  '位移为 0 mm',
  'maximum deflection at midspan = 3.2 mm',
  '最大挠度点位于距端部 3.45 m；挠度为 2 mm',
])('actual displacement magnitudes remain forbidden, including after a location: %s', answer => {
  expect(displacementValueClaims(answer)).toHaveLength(1);
});
