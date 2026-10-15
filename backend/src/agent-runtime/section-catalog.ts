/** Reviewed numerical catalog data. Rolled/tapered I sections are not rectangular-flange H sections. */
const source = {
  title: 'SAMR public GB/T 706 revision draft, Table A.1 / 市场监管总局公开热轧型钢修订草案表A.1',
  url: 'https://std.samr.gov.cn/dcpspTools/gbPlan/download?path=%2Fzxd%2F2024003445%2F20_%E6%A0%87%E5%87%86%E8%B5%B7%E8%8D%89%2F20_WD_2024003445_%E7%83%AD%E8%BD%A7%E5%9E%8B%E9%92%A2.pdf',
  sha256: '1aff5bea9e9c9fdb27c09aa2de9000b00f8760af0ad733f1f994017c7838b5a5',
  status: 'reference-data-from-public-draft',
  axisMapping: 'table Ix -> model Iy; table Iy -> model Iz',
};

/** Only reviewed rows are accepted. No dimensions, torsion, net modulus or code coefficients are inferred. */
export function reviewedSectionRecord(name: string, id: string, purpose: 'beam' | 'column'): Record<string, unknown> | undefined {
  if (name.trim().replace(/Ⅰ/g, 'I').toUpperCase() !== 'I20A') return undefined;
  return {
    id, name: 'I20a', type: 'custom', purpose, width: 100, height: 200,
    properties: { A: 35.55e-4, Iy: 2370e-8, Iz: 158e-8, Wx: 237e-6, Wz: 31.5e-6, tw: 7e-3, imin: 2.12e-2 },
    extra: { catalogSource: { ...source }, catalogDimensionsMM: { H: 200, B: 100, tw: 7, tf: 11.4, r1: 9, r2: 4.5 } },
  };
}
