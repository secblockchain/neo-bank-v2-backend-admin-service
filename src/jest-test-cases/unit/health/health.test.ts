import request from 'supertest';
import app from '../../../app';

describe('GET /health', () => {
  it('returns the service envelope', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('admin-service');
  });
});
