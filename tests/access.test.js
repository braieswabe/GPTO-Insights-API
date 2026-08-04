import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSiteAccess, isUuid, setAccessDbReaderForTests } from '../src/access.js';

const SITE_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const TENANT_ID = '00000000-0000-4000-8000-000000000003';

describe('access control UUID validation', () => {
  afterEach(() => {
    setAccessDbReaderForTests(null);
  });

  it('accepts canonical UUID values', () => {
    assert.equal(isUuid(SITE_ID), true);
    assert.equal(isUuid(USER_ID), true);
    assert.equal(isUuid('codex-smoke'), false);
  });

  it('allows internal administrators to enqueue an all-sites customer refresh', async () => {
    setAccessDbReaderForTests(() => {
      assert.fail('database should not be queried for an all-sites admin refresh');
    });
    await assert.doesNotReject(() => assertSiteAccess({
      siteId: null,
      portalScope: 'customer',
      user: { userId: null, role: 'admin', tenantId: null },
    }));
  });

  it('allows internal administrators to refresh a specific customer site', async () => {
    setAccessDbReaderForTests(() => {
      assert.fail('database should not be queried for an internal administrator');
    });
    await assert.doesNotReject(() => assertSiteAccess({
      siteId: SITE_ID,
      portalScope: 'customer',
      user: { userId: null, role: 'admin', tenantId: null },
    }));
  });

  it('rejects malformed site ids before querying Postgres', async () => {
    setAccessDbReaderForTests(() => {
      assert.fail('database should not be queried for malformed siteId');
    });

    await assert.rejects(
      () => assertSiteAccess({
        siteId: 'not-a-site-id',
        portalScope: 'customer',
        user: { userId: USER_ID, role: 'client', tenantId: null },
      }),
      (error) => error.statusCode === 400 && error.message === 'Invalid siteId'
    );
  });

  it('rejects malformed user id headers before querying Postgres', async () => {
    setAccessDbReaderForTests(() => {
      assert.fail('database should not be queried for malformed user id');
    });

    await assert.rejects(
      () => assertSiteAccess({
        siteId: SITE_ID,
        portalScope: 'customer',
        user: { userId: 'codex-smoke', role: 'client', tenantId: null },
      }),
      (error) => error.statusCode === 400 && error.message === 'Invalid x-gpto-user-id header'
    );
  });

  it('rejects malformed tenant id headers before querying Postgres', async () => {
    setAccessDbReaderForTests(() => {
      assert.fail('database should not be queried for malformed tenant id');
    });

    await assert.rejects(
      () => assertSiteAccess({
        siteId: SITE_ID,
        portalScope: 'customer',
        user: { userId: USER_ID, role: 'client', tenantId: 'tenant-smoke' },
      }),
      (error) => error.statusCode === 400 && error.message === 'Invalid x-gpto-tenant-id header'
    );
  });

  it('allows valid customer-scoped access when a matching row exists', async () => {
    setAccessDbReaderForTests(() => async () => [{ id: SITE_ID }]);

    await assert.doesNotReject(() => assertSiteAccess({
      siteId: SITE_ID,
      portalScope: 'customer',
      user: { userId: USER_ID, role: 'client', tenantId: TENANT_ID },
    }));
  });

  it('returns 403 for valid customer-scoped ids without access', async () => {
    setAccessDbReaderForTests(() => async () => []);

    await assert.rejects(
      () => assertSiteAccess({
        siteId: SITE_ID,
        portalScope: 'customer',
        user: { userId: USER_ID, role: 'client', tenantId: null },
      }),
      (error) => error.statusCode === 403 && error.message === 'Access denied to this site'
    );
  });
});
