/**
 * Client Mongo = Rain users / cards / commerce (customer + US provider DB).
 * Wallet Mongo = multichainswallets / transactions (wallet-server DB).
 * They are separate clusters; admin needs both to show SEP crypto.
 */
import mongoose from 'mongoose';
import { config } from './environment';
import { walletConnection } from '../models/domain.models';
import logger from '../lib/logger';

mongoose.set('autoIndex', false);

const mongoOpts = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  autoIndex: false,
} as const;

export async function connectDB(): Promise<typeof mongoose> {
  const conn = await mongoose.connect(config.MONGODB_URL, mongoOpts);
  logger.info({}, `Client MongoDB Connected: ${conn.connection.host}`);

  const walletUrl = config.WALLET_MONGODB_URL || config.MONGODB_URL;
  if (!config.WALLET_MONGODB_URL) {
    logger.warn(
      {},
      'WALLET_MONGODB_URL unset — crypto models fall back to client DB (usually empty for SEP).',
    );
  }
  await walletConnection.openUri(walletUrl, mongoOpts);
  logger.info(
    {},
    `Wallet MongoDB Connected: ${walletConnection.host} (db=${walletConnection.name})`,
  );

  return conn;
}

export async function disconnectDB(): Promise<void> {
  await Promise.all([
    mongoose.disconnect().catch(() => undefined),
    walletConnection.close().catch(() => undefined),
  ]);
  logger.info({}, 'MongoDB disconnected');
}
