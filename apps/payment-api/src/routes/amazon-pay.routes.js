import { HttpServer } from '../server.js';

export function registerAmazonPayRoutes(server, service) {
  server.get('/api/v1/admin/amazon-pay', async (req, res) => HttpServer.json(res, 200, await service.status()));
  server.post('/api/v1/admin/amazon-pay/config', async (req, res) => {
    try { await service.save(await HttpServer.parseBody(req)); HttpServer.json(res, 200, await service.status()); }
    catch (error) { HttpServer.json(res, error.status || 500, { error: error.message }); }
  });
  server.post('/api/v1/admin/amazon-pay/action', async (req, res) => {
    const { action, acceptSlotRisk, channel } = await HttpServer.parseBody(req);
    if (!['connect', 'enable', 'login', 'start', 'stop', 'scan'].includes(action)) return HttpServer.json(res, 400, { error: 'Invalid action.' });
    if (service.operation) return HttpServer.json(res, 409, { error: 'Another Amazon Pay action is still running.' });
    // Browser startup/scans may take 30 seconds; dashboard polls the resulting state.
    void service.execute(action, { acceptSlotRisk, channel }).catch(() => {});
    HttpServer.json(res, 202, { accepted: true });
  });
}
