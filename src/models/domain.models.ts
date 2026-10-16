import mongoose, { Schema, model, Document, Types, Connection } from 'mongoose';

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

/**
 * Wallet-server owns these collections on a separate Mongo (WALLET_MONGODB_URL).
 * Models bind to `walletConnection` so admin can read crypto without sharing DBs.
 */
export const walletConnection: Connection = mongoose.createConnection();

export const MultichainsWallet = walletConnection.model<LooseDoc>(
  'MultichainsWallet',
  new Schema({}, { ...loose, collection: 'multichainswallets' }),
);
/** Synced on-chain wallet activity (SEP + other chains) from customer / wallet stack. */
export const WalletTransaction = walletConnection.model<LooseDoc>(
  'WalletTransaction',
  new Schema({}, { ...loose, collection: 'wallettransactions' }),
);
/** Wallet-server outbound tx log (stake/withdraw/send). */
export const WalletServerTransaction = walletConnection.model<LooseDoc>(
  'WalletServerTransaction',
  new Schema({}, { ...loose, collection: 'transactions' }),
);
export const SwapTransaction = walletConnection.model<LooseDoc>(
  'SwapTransaction',
  new Schema({}, { ...loose, collection: 'swaptransactions' }),
);
/** Wallet-server stakes live in `stakings` (not `stakingpositions`). */
export const StakingPosition = walletConnection.model<LooseDoc>(
  'StakingPosition',
  new Schema({}, { ...loose, collection: 'stakings' }),
);

export const SupportTicket = model<LooseDoc>(
  'SupportTicket',
  new Schema({}, { ...loose, collection: 'supporttickets' }),
);
export const RainDispute = model<LooseDoc>(
  'RainDispute',
  new Schema({}, { ...loose, collection: 'raindisputes' }),
);
export const RainTransfer = model<LooseDoc>(
  'RainTransfer',
  new Schema({}, { ...loose, collection: 'raintransfers' }),
);
export const RainPaymentAccount = model<LooseDoc>(
  'RainPaymentAccount',
  new Schema({}, { ...loose, collection: 'rainpaymentaccounts' }),
);

/** Customer-service pilot allowlist (email → active). Soft-deactivate only; never hard-delete. */
export const PilotUser = model<LooseDoc>(
  'PilotUser',
  new Schema({}, { ...loose, collection: 'pilotusers' }),
);

export const USER_SECRET_FIELDS =
  '-password -totpSecret -totpSecretIv -totpPendingSecret -totpPendingSecretIv -twoFactorCode -totpBackupCodes';

export function docId(value: unknown): string {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value && typeof value === 'object' && '_id' in value) {
    return docId((value as { _id: unknown })._id);
  }
  return value == null ? '' : String(value);
}
