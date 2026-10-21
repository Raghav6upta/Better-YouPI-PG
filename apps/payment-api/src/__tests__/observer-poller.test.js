import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { getDatabase, ensureDatabaseInitialized, runMigrations, PaymentSessionRepository, ObservationRepository } from '@youpi/db';
import { AttributionEngine } from '@youpi/core';
import { ObserverPollerService } from '../services/observer-poller.service.js';

describe('ObserverPollerService Hardening & Concurrency Protection', () => {
  let db;
  let eventEmitter;
  let sessionRepo;
  let obsRepo;
  let attributionEngine;
  let pollerService;

  beforeEach(() => {
    db = getDatabase(':memory:');
    ensureDatabaseInitialized(db);
    runMigrations(db);

    eventEmitter = new EventEmitter();
    sessionRepo = new PaymentSessionRepository(db);
    obsRepo = new ObservationRepository(db);
    attributionEngine = new AttributionEngine({
      sessionRepo,
      obsRepo,
      eventEmitter
    });
  });

  afterEach(() => {
    if (pollerService) {
      pollerService.destroy();
      pollerService = null;
    }
  });

  test('Requirement 5: Daemon automatically idles when no active or processing sessions exist', async () => {
    pollerService = new ObserverPollerService({
      db,
      sessionRepo,
      obsRepo,
      attributionEngine,
      eventEmitter,
      pollIntervalMs: 1000,
      minSweepCooldownMs: 2000,
      autoStart: false
    });

    // Run poll cycle when DB is completely empty of active sessions
    await pollerService.pollCycle();

    assert.equal(pollerService.isIdle, true, 'Poller must be idle when 0 active sessions exist');
    assert.equal(pollerService.isSmsSweepInFlight, false);
    assert.equal(pollerService.isGmailSweepInFlight, false);
    assert.equal(pollerService.lastSmsSweepTime, 0, 'No SMS sweep should be dispatched when idle');
    assert.equal(pollerService.lastGmailSweepTime, 0, 'No Gmail sweep should be dispatched when idle');
  });

  test('Requirement 3: Enforces minimum cooldown between consecutive sweeps and drops redundant in-flight calls', async () => {
    pollerService = new ObserverPollerService({
      db,
      sessionRepo,
      obsRepo,
      attributionEngine,
      eventEmitter,
      pollIntervalMs: 1000,
      minSweepCooldownMs: 1500, // 1.5s cooldown
      autoStart: false
    });

    // First sweep attempt: should dispatch (returns a promise)
    const sweep1Promise = pollerService.sweepSmsObserver();
    assert.equal(pollerService.isSmsSweepInFlight, true, 'In-flight flag must be true during execution');

    // Immediate second sweep while in-flight: MUST BE DROPPED
    const sweep2 = await pollerService.sweepSmsObserver();
    assert.equal(sweep2, false, 'Redundant in-flight sweep must return false and be dropped');

    await sweep1Promise;
    assert.equal(pollerService.isSmsSweepInFlight, false, 'In-flight flag must reset after completion');

    // Third sweep immediately after, within the 1.5s cooldown window: MUST BE DROPPED
    const sweep3 = await pollerService.sweepSmsObserver();
    assert.equal(sweep3, false, 'Sweep within 1.5s cooldown window must be rejected');

    // Same behavior for Gmail observer
    const gmail1Promise = pollerService.sweepGmailObserver();
    assert.equal(pollerService.isGmailSweepInFlight, true);
    const gmail2 = await pollerService.sweepGmailObserver();
    assert.equal(gmail2, false, 'Concurrent in-flight Gmail sweep must be dropped');
    await gmail1Promise;
    const gmail3 = await pollerService.sweepGmailObserver();
    assert.equal(gmail3, false, 'Gmail sweep within cooldown window must be dropped');
  });

  test('Requirement 4: Mutex and deduplication prevent concurrent attribution and SQLite contention', async () => {
    pollerService = new ObserverPollerService({
      db,
      sessionRepo,
      obsRepo,
      attributionEngine,
      eventEmitter,
      pollIntervalMs: 1000,
      minSweepCooldownMs: 2000,
      autoStart: false
    });

    // Mock active sessions sharing the same receiving account ID
    const activeSessions = [
      { id: 'sess-1', receiving_account_id: 'acc-duplicate-1', amount_paise: 50000, status: 'PROCESSING' },
      { id: 'sess-2', receiving_account_id: 'acc-duplicate-1', amount_paise: 50000, status: 'PROCESSING' },
      { id: 'sess-3', receiving_account_id: 'acc-duplicate-1', amount_paise: 50000, status: 'PROCESSING' }
    ];

    let queryCount = 0;
    const originalFindUnattributed = obsRepo.findUnattributed.bind(obsRepo);
    obsRepo.findUnattributed = (accId) => {
      queryCount++;
      return originalFindUnattributed(accId);
    };

    await pollerService.processPendingAttributions(activeSessions);

    // Invariant: Account IDs are deduplicated so findUnattributed is called exactly ONCE per account!
    assert.equal(queryCount, 1, 'findUnattributed should only be queried once per distinct receiving account');
    assert.equal(pollerService.isAttributionInProgress, false);
  });

  test('Reactive wake-up on SESSION.PROCESSING and SESSION.ACTIVATED without waiting for timer interval', async () => {
    pollerService = new ObserverPollerService({
      db,
      sessionRepo,
      obsRepo,
      attributionEngine,
      eventEmitter,
      pollIntervalMs: 60000, // 60s slow timer
      minSweepCooldownMs: 2000,
      autoStart: true
    });

    let expeditedCalled = false;
    pollerService.triggerExpeditedSweep = () => {
      expeditedCalled = true;
    };

    // Customer clicks "I have paid" -> SESSION.PROCESSING event emitted
    eventEmitter.emit('SESSION.PROCESSING', {
      sessionId: 'sess-active-1',
      receivingAccountId: 'acc-1'
    });

    assert.equal(expeditedCalled, true, 'SESSION.PROCESSING must wake up poller immediately');

    expeditedCalled = false;
    // New session activated -> SESSION.ACTIVATED event emitted
    eventEmitter.emit('SESSION.ACTIVATED', {
      sessionId: 'sess-active-2',
      receivingAccountId: 'acc-1'
    });

    assert.equal(expeditedCalled, true, 'SESSION.ACTIVATED must wake up poller immediately');
  });

  test('Clean lifecycle destruction removes event listeners and clears intervals', () => {
    pollerService = new ObserverPollerService({
      db,
      sessionRepo,
      obsRepo,
      attributionEngine,
      eventEmitter,
      pollIntervalMs: 1000,
      autoStart: true
    });

    assert.equal(pollerService.isRunning, true);
    assert.notEqual(pollerService._timer, null);

    const listenerCountBefore = eventEmitter.listenerCount('SESSION.PROCESSING');
    assert.ok(listenerCountBefore >= 1);

    pollerService.destroy();

    assert.equal(pollerService.isRunning, false);
    assert.equal(pollerService._timer, null);
    assert.equal(eventEmitter.listenerCount('SESSION.PROCESSING'), listenerCountBefore - 1);
  });
});

describe('ObserverPollerService Amazon mode integration', () => {
  let poller;
  let originalFetch;
  let originalAmazonEnabled;
  let requests;
  let observations;
  let attributed;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalAmazonEnabled = process.env.AMAZON_PAY_ENABLED;
    process.env.AMAZON_PAY_ENABLED = 'true';
    requests = [];
    observations = [];
    attributed = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true };
    };
    poller = new ObserverPollerService({
      db: { query: () => [{ id: 'session', receiving_account_id: 'account', status: 'ACTIVE' }] },
      sessionRepo: {},
      obsRepo: { findUnattributed: () => observations },
      attributionEngine: { processObservation: observation => attributed.push(observation) },
      eventEmitter: new EventEmitter(),
      observerToken: 'fixture-observer-token',
      amazonPort: 16004,
      smsPort: 16002,
      gmailPort: 16003,
      autoStart: false
    });
    poller._isRunning = true;
  });
  afterEach(() => {
    poller.destroy();
    globalThis.fetch = originalFetch;
    if (originalAmazonEnabled === undefined) delete process.env.AMAZON_PAY_ENABLED;
    else process.env.AMAZON_PAY_ENABLED = originalAmazonEnabled;
  });

  test('Amazon mode sweeps only Amazon and does not attribute pending bank messages', async () => {
    observations = [
      { id: 'sms', source: 'SMS' },
      { id: 'gmail', source: 'GMAIL' },
      { id: 'amazon', source: 'AMAZON_PAY' }
    ];
    await poller.pollCycle();
    assert.deepEqual(requests.map(request => request.url), ['http://127.0.0.1:16004/api/sweep']);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-observer-token');
    assert.deepEqual(attributed.map(observation => observation.source), ['AMAZON_PAY']);
    assert.equal(await poller.sweepSmsObserver(), false);
    assert.equal(await poller.sweepGmailObserver(), false);
    assert.equal(requests.length, 1);
  });

  test('Amazon sweep drops overlapping and cooldown requests', async () => {
    let finish;
    globalThis.fetch = async url => {
      requests.push(String(url));
      await new Promise(resolve => { finish = resolve; });
      return { ok: true };
    };
    const first = poller.sweepAmazonObserver();
    assert.equal(await poller.sweepAmazonObserver(), false);
    finish();
    assert.equal(await first, true);
    assert.equal(await poller.sweepAmazonObserver(), false);
    assert.equal(requests.length, 1);
  });

  test('paid Amazon sessions do not trigger dual-channel upgrade sweeps', async () => {
    poller.db.query = () => [{ id: 'paid', receiving_account_id: 'account', status: 'SUCCESS' }];
    await poller.pollCycle();
    assert.equal(poller.isIdle, true);
    assert.equal(requests.length, 0);
  });

  test('dashboard mode changes take effect without starting a second polling daemon', async () => {
    process.env.AMAZON_PAY_ENABLED = 'false';
    await poller.pollCycle();
    assert.deepEqual(requests.map(request => request.url).sort(), [
      'http://localhost:16002/api/sweep', 'http://localhost:16003/api/sweep'
    ]);
    process.env.AMAZON_PAY_ENABLED = 'true';
    await poller.pollCycle();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, 'http://127.0.0.1:16004/api/sweep');
  });
});
