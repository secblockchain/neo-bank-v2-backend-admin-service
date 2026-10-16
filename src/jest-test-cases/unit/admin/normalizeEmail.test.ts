import { normalizeEmailAddress } from '../../../utils/normalizeEmail';

describe('normalizeEmailAddress', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmailAddress('  Pilot@Example.COM ')).toBe('pilot@example.com');
  });

  it('strips Gmail dots and +tags and maps googlemail to gmail.com', () => {
    expect(normalizeEmailAddress('John.Doe+promo@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmailAddress('johndoe@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmailAddress('John.Doe@googlemail.com')).toBe('johndoe@gmail.com');
  });

  it('strips Outlook +tags', () => {
    expect(normalizeEmailAddress('user+tag@outlook.com')).toBe('user@outlook.com');
    expect(normalizeEmailAddress('user+tag@hotmail.com')).toBe('user@hotmail.com');
  });

  it('strips Yahoo -tags', () => {
    expect(normalizeEmailAddress('user-tag@yahoo.com')).toBe('user@yahoo.com');
  });

  it('strips iCloud +tags', () => {
    expect(normalizeEmailAddress('user+tag@icloud.com')).toBe('user@icloud.com');
  });

  it.each(['', '   ', 'not-an-email', 'a@', '@b.com', 'a b@c.com'])(
    'rejects %p as not an e-mail address',
    (raw) => {
      expect(normalizeEmailAddress(raw)).toBeNull();
    },
  );

  it('rejects non-string input', () => {
    expect(normalizeEmailAddress(null as unknown as string)).toBeNull();
    expect(normalizeEmailAddress(42 as unknown as string)).toBeNull();
  });
});
