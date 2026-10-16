import { Model } from 'mongoose';
import { LooseDoc } from '../models/domain.models';
import { ApiError } from './ApiError';

/**
 * True only when the model's collection is present.
 * A closed connection throws so callers cannot treat a database outage as an empty result.
 */
export async function collectionExists(model: Model<LooseDoc>): Promise<boolean> {
  const db = model.db?.db;
  if (!db) {
    throw new ApiError(503, `Mongo connection is not open for ${model.collection.collectionName}.`);
  }
  const listed = await db
    .listCollections({ name: model.collection.collectionName }, { nameOnly: true })
    .toArray();
  return listed.length > 0;
}
