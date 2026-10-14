import { Schema, model, Document, Types } from 'mongoose';

/**
 * Read models for collections owned by the other US services.
 * strict:false so this service can query them without copying every schema field.
 * autoIndex is off — those services own the indexes.
 */
const loose = { strict: false, autoIndex: false, timestamps: true } as const;

export type LooseDoc = Document & Record<string, unknown>;

export const RainUser = model<LooseDoc>('RainUser', new Schema({}, loose));
export const RainKyc = model<LooseDoc>('RainKyc', new Schema({}, loose));
export const RainKyb = model<LooseDoc>(
  'RainKyb',
  new Schema({}, { ...loose, collection: 'rainkybs' }),
);
export const Subscription = model<LooseDoc>('Subscription', new Schema({}, loose));
export const Charge = model<LooseDoc>(
  'Charge',
  new Schema({}, { strict: false, autoIndex: false, collection: 'charges' }),
);
export const Package = model<LooseDoc>('Package', new Schema({}, loose));
export const Card = model<LooseDoc>('Card', new Schema({}, loose));
export const PayPalOrder = model<LooseDoc>('PayPalOrder', new Schema({}, loose));
export const StripePayment = model<LooseDoc>('StripePayment', new Schema({}, loose));
export const WertTransaction = model<LooseDoc>('WertTransaction', new Schema({}, loose));
export const SavingsPlan = model<LooseDoc>('SavingsPlan', new Schema({}, loose));
export const Notification = model<LooseDoc>('Notification', new Schema({}, loose));
export const Logs = model<LooseDoc>('Logs', new Schema({}, { ...loose, timestamps: false }));

export const USER_SECRET_FIELDS =
  '-password -totpSecret -totpSecretIv -totpPendingSecret -totpPendingSecretIv -twoFactorCode -totpBackupCodes';

export function docId(value: unknown): string {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value && typeof value === 'object' && '_id' in value) {
    return docId((value as { _id: unknown })._id);
  }
  return value == null ? '' : String(value);
}
