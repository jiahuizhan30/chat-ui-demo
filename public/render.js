// Safe-ish markdown rendering for model output. The model's output is UNTRUSTED.
// (OWASP LLM05: Improper Output Handling.) Shared by the browser and the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatRender = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // DEFENSE (when blockExternalImages is on): only images from these prefixes may load.
  // In a real app this is an allowlist of trusted hosts (or a proxy), not a blocklist.
  const ALLOWED_IMAGE_PREFIXES = ['/static/'];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderMarkdown(text, opts) {
    opts = opts || {};
    let html = escapeHtml(text); // escape FIRST so model output can never inject tags
    html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      const allowed = ALLOWED_IMAGE_PREFIXES.some(function (p) { return url.indexOf(p) === 0; });
      if (opts.blockExternalImages && !allowed) return '<span class="blocked">🚫 image blocked</span>';
      return '<img alt="' + alt + '" src="' + url + '">';
    });
    return html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }

  return { escapeHtml: escapeHtml, renderMarkdown: renderMarkdown, ALLOWED_IMAGE_PREFIXES: ALLOWED_IMAGE_PREFIXES };
});
