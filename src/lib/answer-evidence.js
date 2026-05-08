/**
 * Build "what to do next" suggestions for a single AI answer evidence row.
 * Mirrors apps/dashboard/src/lib/llm-mentions-search-evidence.ts so the gateway
 * is the only place that produces Answer Evidence suggestions.
 */
function normalizeHost(domain) {
  if (typeof domain !== 'string') return '';
  return domain.replace(/^www\./i, '').toLowerCase().trim();
}

function brandHostMatches(domain, siteDomain) {
  if (!siteDomain || typeof siteDomain !== 'string' || !siteDomain.trim()) return false;
  const brand = normalizeHost(siteDomain);
  const host = normalizeHost(domain);
  if (!brand || !host) return false;
  return host === brand || host.endsWith(`.${brand}`);
}

export function buildEvidenceSuggestions(example, siteDomain) {
  if (!example) return [];
  const out = [];
  const citedDomains = Array.isArray(example.citedDomains) ? example.citedDomains : [];
  const retrievedDomains = Array.isArray(example.retrievedDomains) ? example.retrievedDomains : [];
  const fanOutQueries = Array.isArray(example.fanOutQueries) ? example.fanOutQueries : [];
  const brandEntities = Array.isArray(example.brandEntities) ? example.brandEntities : [];
  const sourceUrls = Array.isArray(example.sourceUrls) ? example.sourceUrls : [];

  const brandCited = siteDomain ? citedDomains.some((d) => brandHostMatches(d, siteDomain)) : false;
  const brandRetrievedNotCited =
    Boolean(siteDomain) &&
    !citedDomains.some((d) => brandHostMatches(d, siteDomain)) &&
    retrievedDomains.some((d) => brandHostMatches(d, siteDomain));

  if (brandRetrievedNotCited) {
    out.push(
      'Your domain appears in retrieval signals but not in the cited-source line for this answer. Add a concise, quotable definition block (who you serve, geography, licensing context) plus FAQ and HowTo schema on the URL that already ranks for this topic so the model can attach a citation.'
    );
  }

  if (citedDomains.length === 0 && retrievedDomains.length > 0) {
    out.push(
      'The answer leaned on web results without listing explicit cited domains in this snapshot. Compare the retrieved domains above to your Top Cited Domains leaderboard, then strengthen partnerships or summaries on the URLs those winners use so your property can occupy a similar “source of truth” slot.'
    );
  }

  if (fanOutQueries.length > 0) {
    out.push(
      `Fan-out queries (${Math.min(fanOutQueries.length, 5)} variant${fanOutQueries.length === 1 ? '' : 's'} in this sample) show how the model broadened the topic. Create or tighten one landing page per distinct intent and cross-link them so each variant resolves to authoritative copy.`
    );
  }

  if (brandEntities.length > 0) {
    out.push(
      'Named entities were detected. Align on-brand spelling, legal entity names, and service categories everywhere they appear (site, GBP, job posts, partner pages) so recognition stays consistent across refreshes.'
    );
  }

  if (sourceUrls.length > 0) {
    out.push(
      'Source URLs were attached to this answer. Audit those pages for a strong first screen, dated facts, and short paragraphs models can excerpt; refresh stale numbers so you are not quoted with outdated requirements.'
    );
  }

  if (brandCited && siteDomain) {
    out.push(
      'Your host is among cited sources for this sample. Protect the citation with periodic refreshes, visible “last updated” context, and internal links from sibling pages so the model keeps seeing a coherent entity graph.'
    );
  }

  if (out.length === 0) {
    out.push(
      'Use this row as a baseline snapshot. After you ship content or schema changes, run another refresh and compare cited versus retrieved domains to see whether the model’s sourcing behavior moved in your favor.'
    );
  }

  return out.slice(0, 5);
}
