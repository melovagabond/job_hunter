function parseAnnualSalary(text) {
  if (!text) return {};
  const values = [];
  const pattern = /(?:\$|USD\s*)?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s*[kK])\b/g;
  for (const match of String(text).matchAll(pattern)) {
    const raw = match[1].replace(/,/g, '').trim();
    const value = /k$/i.test(raw) ? parseFloat(raw) * 1000 : parseFloat(raw);
    if (value >= 20000 && value <= 2000000) values.push(Math.round(value));
  }
  if (!values.length) return {};
  return { salaryMin: Math.min(...values), salaryMax: Math.max(...values) };
}

function annualizeSalary(value, period = 'annual') {
  if (value == null || value === '') return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return undefined;
  const key = String(period).toLowerCase();
  const multiplier = {
    hour: 2080, hourly: 2080, hr: 2080,
    day: 260, daily: 260,
    week: 52, weekly: 52,
    fortnight: 26, fortnightly: 26,
    month: 12, monthly: 12,
    year: 1, yearly: 1, annual: 1, annually: 1
  }[key] || 1;
  return Math.round(amount * multiplier);
}

function detectCurrency(text, fallback = 'USD') {
  const value = String(text || '');
  if (/\bCAD\b|C\$/i.test(value)) return 'CAD';
  if (/\bEUR\b|€/i.test(value)) return 'EUR';
  if (/\bGBP\b|£/i.test(value)) return 'GBP';
  if (/\bUSD\b|US\$/i.test(value)) return 'USD';
  return fallback;
}

function parseCompensation(text, fallbackCurrency = 'USD') {
  const value = String(text || '');
  const currency = detectCurrency(value, fallbackCurrency);
  const amount = '(\\d+(?:[,.]\\d+)?)\\s*([kK])?';
  const currencyLead = '(?:(?:USD|CAD|EUR|GBP|US\\$|C\\$)\\s*[$€£]?|[$€£])\\s*';
  const between = '\\s*[–—-]\\s*(?:(?:USD|CAD|EUR|GBP|US\\$|C\\$)\\s*[$€£]?|[$€£])?\\s*';
  const period = '\\s*(?:\\/|per\\s+)?\\s*(hr|hour|hourly|yr|year|yearly|annual|month|monthly)?';
  const range = value.match(new RegExp(currencyLead + amount + between + amount + period, 'i'))
    || value.match(new RegExp(amount + between + amount + '\\s*(?:\\/|per\\s+)?\\s*(hr|hour|hourly|yr|year|yearly|annual|month|monthly)', 'i'));
  if (!range) return { currency };
  const number = (raw, thousands) => {
    const parsed = Number(raw.replace(/,/g, ''));
    return thousands ? parsed * 1000 : parsed;
  };
  const payPeriod = range[5] || (/\b(?:hr|hour|hourly)\b/i.test(value) ? 'hourly' : 'annual');
  const salaryMin = annualizeSalary(number(range[1], range[2]), payPeriod);
  const salaryMax = annualizeSalary(number(range[3], range[4]), payPeriod);
  if (salaryMin < 20000 || salaryMax > 2000000) return { currency };
  return {
    salaryMin,
    salaryMax,
    currency
  };
}

module.exports = { parseAnnualSalary, annualizeSalary, detectCurrency, parseCompensation };
