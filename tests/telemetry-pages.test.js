import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateValidTelemetryTopPages,
  isTelemetryPageEligibleForTopPages,
  isWordPressAdminOrEditorTelemetryUrl,
  normalizeTelemetryTopPageUrl,
} from '../src/lib/telemetry-pages.js';

describe('telemetry page filtering', () => {
  it('excludes WordPress admin and editor URLs', () => {
    assert.equal(isWordPressAdminOrEditorTelemetryUrl('https://freymiller.com/wp-admin/post.php?post=1&action=edit'), true);
    assert.equal(isTelemetryPageEligibleForTopPages({ url: 'https://freymiller.com/services/refrigerated-truck/?vc_editable=true&vc_post_id=118&_vcnonce=abc' }), false);
    assert.equal(isTelemetryPageEligibleForTopPages({ url: 'https://freymiller.com/?customize_changeset_uuid=abc&customize_theme=child' }), false);
  });

  it('keeps normal public WordPress URLs', () => {
    assert.equal(isTelemetryPageEligibleForTopPages({ url: 'https://freymiller.com/services/refrigerated-truck/', title: 'Refrigerated Truck' }), true);
  });

  it('normalizes tracking query URLs to clean public page URLs', () => {
    assert.equal(normalizeTelemetryTopPageUrl('https://freymiller.com/?ex_cid=campaign#top'), 'https://freymiller.com/');
  });

  it('aggregates public query variants and filters invalid top pages', () => {
    const pages = aggregateValidTelemetryTopPages([
      { url: 'https://freymiller.com/', count: 116 },
      { url: 'https://freymiller.com/?ex_cid=campaign', count: 33 },
      { url: 'https://freymiller.com/call-center', title: 'Page not found - Freymiller', count: 61 },
      { url: 'https://freymiller.com/services/refrigerated-truck/?vc_editable=true&vc_post_id=118', count: 15 },
      { url: 'https://freymiller.com/services/refrigerated-truck/', count: 15 },
    ]);

    assert.deepEqual(pages.map((page) => ({ url: page.url, count: page.count })), [
      { url: 'https://freymiller.com/', count: 149 },
      { url: 'https://freymiller.com/services/refrigerated-truck/', count: 15 },
    ]);
  });
});
