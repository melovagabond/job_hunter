function decodeXml(value) {
  let result = String(value || '').replace(/^<!\[CDATA\[|\]\]>$/g, '');
  for (let pass = 0; pass < 2; pass++) {
    result = result
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
  return result.trim();
}

function field(block, name) {
  const escaped = name.replace(':', '\\:');
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return decodeXml(match ? match[1] : '');
}

function fields(block, name) {
  const escaped = name.replace(':', '\\:');
  return [...block.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))]
    .map(match => decodeXml(match[1]));
}

function parseRss(xml) {
  return [...String(xml || '').matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .map(match => {
      const block = match[1];
      return {
        title: field(block, 'title'),
        link: field(block, 'link'),
        guid: field(block, 'guid'),
        description: field(block, 'description'),
        pubDate: field(block, 'pubDate'),
        expiresAt: field(block, 'expires_at'),
        region: field(block, 'region'),
        country: field(block, 'country'),
        state: field(block, 'state'),
        type: field(block, 'type'),
        categories: fields(block, 'category')
      };
    });
}

module.exports = { decodeXml, parseRss };
