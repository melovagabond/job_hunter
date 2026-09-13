function isUsEligibleRemote(location) {
  const value = String(location || '').trim().toLowerCase();
  if (!value || value === 'remote') return true;
  if (/anywhere|worldwide|global|north america|americas/.test(value)) return true;
  return /united states|u\.s\.|\busa\b|\bus[- ](?:only|based|remote)\b/.test(value);
}

module.exports = { isUsEligibleRemote };
