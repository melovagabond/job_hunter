function isConfigured(value) {
  if (!value) return false;
  return !/^(your_|you@example\.com$|change_me|replace_me)/i.test(value.trim());
}

module.exports = { isConfigured };
