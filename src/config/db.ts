/**
 * Shared US Mongo. Customer, subscription, and US provider already use this database.
 * autoIndex is off so this service never rewrites indexes owned by those services.
 */
import mongoose from 'mongoose';
import { config } from './environment';
import logger from '../lib/logger';

mongoose.set('autoIndex', false);

export async function connectDB(): Promise<typeof mongoose> {
  const conn = await mongoose.connect(config.MONGODB_URL, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    autoIndex: false,
  });
  logger.info({}, `MongoDB Connected: ${conn.connection.host}`);
  return conn;
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info({}, 'MongoDB disconnected');
}
