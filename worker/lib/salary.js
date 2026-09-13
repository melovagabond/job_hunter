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

module.exports = { parseAnnualSalary };
