import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshJobSiteIdValue } from '../src/jobs.js';

describe('refresh job site ids', () => {
  it('stores all-sites refresh jobs with NULL site_id so the sites FK is not violated', () => {
    assert.equal(refreshJobSiteIdValue({ siteId: null }), null);
    assert.equal(refreshJobSiteIdValue({}), null);
  });

  it('stores site-scoped refresh jobs with their real site id', () => {
    const siteId = '439becf4-c754-4fd6-ad8b-c8ad13d602de';
    assert.equal(refreshJobSiteIdValue({ siteId }), siteId);
  });
});
