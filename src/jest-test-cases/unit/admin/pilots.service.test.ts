const rainUserExists = jest.fn();
const pilotCountDocuments = jest.fn();
const pilotLean = jest.fn();
const pilotSkip = jest.fn(() => ({ limit: jest.fn(() => ({ lean: pilotLean })) }));
const pilotSort = jest.fn(() => ({ skip: pilotSkip }));
const pilotFind = jest.fn((_filter?: unknown) => ({ sort: pilotSort }));
const pilotFindOneAndUpdate = jest.fn();
const recordAudit = jest.fn();

jest.mock('../../../models/domain.models', () => ({
  RainUser: { exists: (...args: unknown[]) => rainUserExists(...args) },
  PilotUser: {
    countDocuments: (...args: unknown[]) => pilotCountDocuments(...args),
    find: (filter?: unknown) => pilotFind(filter),
    findOneAndUpdate: (...args: unknown[]) => pilotFindOneAndUpdate(...args),
  },
}));

jest.mock('../../../services/audit.service', () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...args),
}));

import { ApiError } from '../../../utils/ApiError';
import { addPilot, deactivatePilot, listPilots } from '../../../services/pilots.service';

const actor = { id: '507f1f77bcf86cd799439011', email: 'admin@example.com' };

describe('pilots.service', () => {
  beforeEach(() => {
    rainUserExists.mockReset();
    pilotCountDocuments.mockReset();
    pilotLean.mockReset();
    pilotFind.mockClear();
    pilotSort.mockClear();
    pilotSkip.mockClear();
    pilotFindOneAndUpdate.mockReset();
    recordAudit.mockReset();
    rainUserExists.mockResolvedValue({ _id: 'rain-user' });
  });

  describe('listPilots', () => {
    it('escapes regex metacharacters in search', async () => {
      pilotCountDocuments.mockResolvedValue(0);
      pilotLean.mockResolvedValue([]);

      await listPilots({ search: 'a+b@c.com' }, 0, 20);

      expect(pilotFind).toHaveBeenCalledWith({
        email: { $regex: 'a\\+b@c\\.com', $options: 'i' },
      });
    });

    it('caps search length before building the regex', async () => {
      pilotCountDocuments.mockResolvedValue(0);
      pilotLean.mockResolvedValue([]);
      const long = `${'a'.repeat(150)}@example.com`;

      await listPilots({ search: long }, 0, 20);

      const filter = pilotFind.mock.calls[0][0] as unknown as { email: { $regex: string } };
      expect(filter.email.$regex.length).toBeLessThanOrEqual(100);
    });
  });

  describe('addPilot', () => {
    it('upserts the normalized e-mail and re-activates a removed pilot', async () => {
      pilotFindOneAndUpdate.mockResolvedValue({ email: 'johndoe@gmail.com', active: true });

      await addPilot(actor, 'John.Doe+x@Gmail.com', ' partner ');

      expect(rainUserExists).toHaveBeenCalledWith({ email: 'johndoe@gmail.com' });
      const [filter, update, options] = pilotFindOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ email: 'johndoe@gmail.com' });
      expect(update.$set).toEqual({
        active: true,
        deactivatedAt: null,
        addedBy: 'admin@example.com',
        note: 'partner',
      });
      expect(update.$setOnInsert).toEqual({ email: 'johndoe@gmail.com' });
      expect(options).toMatchObject({ upsert: true, new: true });
      expect(recordAudit).toHaveBeenCalledWith(
        actor,
        'pilot.add',
        'pilot',
        'johndoe@gmail.com',
        { note: 'partner' },
      );
    });

    it('returns 404 when no RainUser exists for the normalized e-mail', async () => {
      rainUserExists.mockResolvedValue(null);

      await expect(addPilot(actor, 'ghost@example.com')).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(pilotFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects an invalid e-mail without writing', async () => {
      await expect(addPilot(actor, 'not-an-email')).rejects.toBeInstanceOf(ApiError);
      expect(rainUserExists).not.toHaveBeenCalled();
      expect(pilotFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a note over the length limit', async () => {
      await expect(addPilot(actor, 'a@example.com', 'x'.repeat(501))).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(pilotFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('deactivatePilot', () => {
    it('soft-deactivates an active pilot and audits', async () => {
      pilotFindOneAndUpdate.mockResolvedValue({ email: 'a@example.com', active: false });

      await deactivatePilot(actor, 'A@Example.com');

      expect(pilotFindOneAndUpdate).toHaveBeenCalledWith(
        { email: 'a@example.com', active: true },
        { $set: { active: false, deactivatedAt: expect.any(Date) } },
        { new: true },
      );
      expect(recordAudit).toHaveBeenCalledWith(actor, 'pilot.deactivate', 'pilot', 'a@example.com');
    });

    it('returns 404 when no active pilot matches', async () => {
      pilotFindOneAndUpdate.mockResolvedValue(null);

      await expect(deactivatePilot(actor, 'missing@example.com')).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});
