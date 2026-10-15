const { isDeepStrictEqual } = require('node:util');

const atPath = (value, field) => field.split('.').reduce((item, key) => item == null ? undefined : item[key], value);

function validateModelExpectations(expectations = []) {
  if (!Array.isArray(expectations)) throw new Error('expectedModelValues must be an array');
  for (const [index, rule] of expectations.entries()) {
    const valid = rule && typeof rule === 'object' && Object.hasOwn(rule, 'value')
      && typeof rule.path === 'string' && rule.path.length > 0
      && (rule.collection === undefined || (typeof rule.collection === 'string' && rule.collection.length > 0))
      && (rule.id === undefined || ['string', 'number'].includes(typeof rule.id))
      && (rule.where === undefined || (rule.where && typeof rule.where === 'object' && !Array.isArray(rule.where)))
      && !(rule.id !== undefined && rule.where !== undefined)
      && (rule.collection !== undefined || (rule.id === undefined && rule.where === undefined))
      && (rule.minMatches === undefined || (Number.isInteger(rule.minMatches) && rule.minMatches >= 1))
      && (rule.absoluteTolerance === undefined || (typeof rule.value === 'number' && Number.isFinite(rule.absoluteTolerance) && rule.absoluteTolerance >= 0));
    if (!valid) throw new Error(`Invalid expectedModelValues[${index}]`);
  }
}

// Read-only assertions over persisted input-review.model. These values never enter chat.
// Collection selectors test EVERY match, and an empty selection always fails.
function checkModelValues(model, expectations = []) {
  validateModelExpectations(expectations);
  return expectations.map((rule, index) => {
    const collection = rule.collection === undefined ? [model] : atPath(model, rule.collection);
    const matches = (Array.isArray(collection) ? collection : []).filter(item => {
      if (!item || typeof item !== 'object') return false;
      if (rule.id !== undefined) return String(item.id) === String(rule.id);
      return Object.entries(rule.where ?? {}).every(([field, value]) => isDeepStrictEqual(atPath(item, field), value));
    });
    const results = matches.map(item => {
      const actual = atPath(item, rule.path);
      const pass = rule.absoluteTolerance === undefined ? isDeepStrictEqual(actual, rule.value)
        : Number.isFinite(actual) && Math.abs(actual - rule.value) <= rule.absoluteTolerance;
      return { id: item.id, present: actual !== undefined, actual, pass };
    });
    const minimum = rule.minMatches ?? 1;
    return { index, ...rule, matched: matches.length, results,
      pass: matches.length >= minimum && (rule.id === undefined || matches.length === 1) && results.every(result => result.pass) };
  });
}

module.exports = { validateModelExpectations, checkModelValues };
