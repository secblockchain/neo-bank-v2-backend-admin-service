import { FilterQuery } from 'mongoose';
import { LooseDoc } from '../models/domain.models';

/**
 * Build a createdAt range filter from dateFrom/dateTo or createdFrom/createdTo query params.
 */
export function createdAtRangeFilter(query: Record<string, unknown>): FilterQuery<LooseDoc> {
  const fromRaw =
    (typeof query.dateFrom === 'string' && query.dateFrom) ||
    (typeof query.createdFrom === 'string' && query.createdFrom) ||
    '';
  const toRaw =
    (typeof query.dateTo === 'string' && query.dateTo) ||
    (typeof query.createdTo === 'string' && query.createdTo) ||
    '';

  if (!fromRaw && !toRaw) return {};

  const range: { $gte?: Date; $lte?: Date } = {};
  if (fromRaw) {
    const from = new Date(fromRaw);
    if (!Number.isNaN(from.getTime())) range.$gte = from;
  }
  if (toRaw) {
    const to = new Date(toRaw);
    if (!Number.isNaN(to.getTime())) {
      // Inclusive end-of-day when only a date is provided
      if (/^\d{4}-\d{2}-\d{2}$/.test(toRaw.trim())) {
        to.setUTCHours(23, 59, 59, 999);
      }
      range.$lte = to;
    }
  }
  if (!range.$gte && !range.$lte) return {};
  return { createdAt: range };
}

export function mergeFilters(
  ...parts: FilterQuery<LooseDoc>[]
): FilterQuery<LooseDoc> {
  const and: FilterQuery<LooseDoc>[] = [];
  for (const part of parts) {
    if (part && Object.keys(part).length) and.push(part);
  }
  if (!and.length) return {};
  if (and.length === 1) return and[0];
  return { $and: and };
}
