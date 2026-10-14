import { Schema, model, Document, Types } from 'mongoose';
import { ADMIN_ROLE } from '../enums/adminRoles';

const adminOptions = { timestamps: true, autoIndex: true };

export interface IAdminAccount extends Document {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: ADMIN_ROLE;
  active: boolean;
  sessionsInvalidatedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const adminAccountSchema = new Schema<IAdminAccount>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    role: { type: String, enum: Object.values(ADMIN_ROLE), required: true },
    active: { type: Boolean, default: true },
    sessionsInvalidatedAt: { type: Date, default: null },
  },
  adminOptions,
);

export const AdminAccount = model<IAdminAccount>('AdminAccount', adminAccountSchema);

export interface IAdminAudit extends Document {
  actorId: Types.ObjectId;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  createdAt?: Date;
}

const adminAuditSchema = new Schema<IAdminAudit>(
  {
    actorId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, autoIndex: true },
);

export const AdminAudit = model<IAdminAudit>('AdminAudit', adminAuditSchema);

export interface IAdminNote extends Document {
  userId: Types.ObjectId;
  authorId: Types.ObjectId;
  authorEmail: string;
  body: string;
  createdAt?: Date;
}

export const AdminNote = model<IAdminNote>(
  'AdminNote',
  new Schema<IAdminNote>(
    {
      userId: { type: Schema.Types.ObjectId, required: true, index: true },
      authorId: { type: Schema.Types.ObjectId, required: true },
      authorEmail: { type: String, required: true },
      body: { type: String, required: true, maxlength: 4000 },
    },
    { timestamps: { createdAt: true, updatedAt: false }, autoIndex: true },
  ),
);

export interface IAdminUserTag extends Document {
  userId: Types.ObjectId;
  tags: string[];
}

export const AdminUserTag = model<IAdminUserTag>(
  'AdminUserTag',
  new Schema<IAdminUserTag>(
    {
      userId: { type: Schema.Types.ObjectId, required: true, unique: true },
      tags: { type: [String], default: [] },
    },
    adminOptions,
  ),
);

export interface IFeatureFlag extends Document {
  key: string;
  description: string;
  enabled: boolean;
  updatedBy?: string;
}

export const FeatureFlag = model<IFeatureFlag>(
  'AdminFeatureFlag',
  new Schema<IFeatureFlag>(
    {
      key: { type: String, required: true, unique: true, lowercase: true, trim: true },
      description: { type: String, default: '' },
      enabled: { type: Boolean, default: false },
      updatedBy: { type: String },
    },
    adminOptions,
  ),
);

export interface ISavedView extends Document {
  ownerId: Types.ObjectId;
  name: string;
  resource: string;
  query: Record<string, unknown>;
}

export const SavedView = model<ISavedView>(
  'AdminSavedView',
  new Schema<ISavedView>(
    {
      ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
      name: { type: String, required: true, maxlength: 80 },
      resource: { type: String, required: true },
      query: { type: Schema.Types.Mixed, default: {} },
    },
    adminOptions,
  ),
);

export const FRAUD_CASE_STATUSES = ['open', 'investigating', 'resolved', 'dismissed'] as const;
export type FraudCaseStatus = (typeof FRAUD_CASE_STATUSES)[number];

export interface IFraudCase extends Document {
  userId?: Types.ObjectId;
  title: string;
  summary: string;
  status: FraudCaseStatus;
  notes: Array<{ authorEmail: string; body: string; createdAt: Date }>;
  createdBy: string;
}

export const FraudCase = model<IFraudCase>(
  'AdminFraudCase',
  new Schema<IFraudCase>(
    {
      userId: { type: Schema.Types.ObjectId, index: true },
      title: { type: String, required: true, maxlength: 160 },
      summary: { type: String, default: '' },
      status: { type: String, enum: FRAUD_CASE_STATUSES, default: 'open', index: true },
      notes: {
        type: [
          new Schema(
            {
              authorEmail: { type: String, required: true },
              body: { type: String, required: true },
              createdAt: { type: Date, default: Date.now },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
      createdBy: { type: String, required: true },
    },
    adminOptions,
  ),
);

export const PENDING_ACTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

export interface IPendingAction extends Document {
  type: string;
  status: PendingActionStatus;
  payload: Record<string, unknown>;
  proposedBy: Types.ObjectId;
  proposedByEmail: string;
  decidedBy?: Types.ObjectId;
  decidedByEmail?: string;
  decisionNote?: string;
  decidedAt?: Date;
}

export const PendingAction = model<IPendingAction>(
  'AdminPendingAction',
  new Schema<IPendingAction>(
    {
      type: { type: String, required: true, index: true },
      status: { type: String, enum: PENDING_ACTION_STATUSES, default: 'pending', index: true },
      payload: { type: Schema.Types.Mixed, required: true },
      proposedBy: { type: Schema.Types.ObjectId, required: true },
      proposedByEmail: { type: String, required: true },
      decidedBy: { type: Schema.Types.ObjectId },
      decidedByEmail: { type: String },
      decisionNote: { type: String },
      decidedAt: { type: Date },
    },
    adminOptions,
  ),
);

export interface ISecuritySettings extends Document {
  key: string;
  killSwitch: boolean;
  ipAllowlist: string[];
  updatedBy?: string;
}

export const SecuritySettings = model<ISecuritySettings>(
  'AdminSecuritySettings',
  new Schema<ISecuritySettings>(
    {
      key: { type: String, required: true, unique: true, default: 'default' },
      killSwitch: { type: Boolean, default: false },
      ipAllowlist: { type: [String], default: [] },
      updatedBy: { type: String },
    },
    adminOptions,
  ),
);
