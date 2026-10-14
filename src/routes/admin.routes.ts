import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticateAdmin } from '../middlewares/authenticateAdmin';
import { adminGuard } from '../middlewares/adminGuard';
import { requirePermission, requireSuperAdmin } from '../middlewares/requirePermission';
import { ADMIN_PERMISSION } from '../enums/adminRoles';
import * as admin from '../controllers/admin/admin.controller';

const router = Router();
const viewDashboard = requirePermission(ADMIN_PERMISSION.VIEW_DASHBOARD);
const viewUsers = requirePermission(ADMIN_PERMISSION.VIEW_USERS);
const manageUsers = requirePermission(ADMIN_PERMISSION.MANAGE_USERS);
const viewCompliance = requirePermission(ADMIN_PERMISSION.VIEW_COMPLIANCE);
const manageKyc = requirePermission(ADMIN_PERMISSION.MANAGE_KYC);
const viewFinance = requirePermission(ADMIN_PERMISSION.VIEW_FINANCE);
const manageSubscriptions = requirePermission(ADMIN_PERMISSION.MANAGE_SUBSCRIPTIONS);
const viewTransactions = requirePermission(ADMIN_PERMISSION.VIEW_TRANSACTIONS);
const manageCards = requirePermission(ADMIN_PERMISSION.MANAGE_CARDS);
const manageSavings = requirePermission(ADMIN_PERMISSION.MANAGE_SAVINGS);
const viewMarketing = requirePermission(ADMIN_PERMISSION.VIEW_MARKETING);
const manageReferrals = requirePermission(ADMIN_PERMISSION.MANAGE_REFERRALS);
const manageNotifications = requirePermission(ADMIN_PERMISSION.MANAGE_NOTIFICATIONS);
const viewAudit = requirePermission(ADMIN_PERMISSION.VIEW_AUDIT);
const viewSystem = requirePermission(ADMIN_PERMISSION.VIEW_SYSTEM);
const manageFlags = requirePermission(ADMIN_PERMISSION.MANAGE_FEATURE_FLAGS);
const viewFraud = requirePermission(ADMIN_PERMISSION.VIEW_FRAUD);
const manageFraud = requirePermission(ADMIN_PERMISSION.MANAGE_FRAUD);
const approve = requirePermission(ADMIN_PERMISSION.APPROVE_SENSITIVE_ACTIONS);
const manageAdmins = requirePermission(ADMIN_PERMISSION.MANAGE_ADMINS);
const impersonate = requirePermission(ADMIN_PERMISSION.IMPERSONATE_USERS);

router.post('/auth/login', asyncHandler(admin.login));

router.use(asyncHandler(authenticateAdmin));
router.use(asyncHandler(adminGuard));

router.post('/auth/logout', asyncHandler(admin.logout));
router.get('/admins/me/permissions', asyncHandler(admin.me));
router.get('/admins/roles', asyncHandler(admin.roleCatalog));
router.get('/admins', manageAdmins, asyncHandler(admin.getAdmins));
router.post('/admins', manageAdmins, asyncHandler(admin.postAdmin));
router.put('/admins/:userId/role', manageAdmins, asyncHandler(admin.putAdminRole));

router.get('/search', viewUsers, asyncHandler(admin.search));
router.get('/dashboard/overview', viewDashboard, asyncHandler(admin.overview));

router.get('/users/analytics', viewUsers, asyncHandler(admin.userAnalytics));
router.get('/users/tags/all', viewUsers, asyncHandler(admin.allTags));
router.get('/users/list', viewUsers, asyncHandler(admin.userList));
router.get('/users/:userId/profile', viewUsers, asyncHandler(admin.userProfile));
router.get('/users/:userId/notes', viewUsers, asyncHandler(admin.userNotes));
router.post('/users/:userId/notes', manageUsers, asyncHandler(admin.userAddNote));
router.put('/users/:userId/tags', manageUsers, asyncHandler(admin.userTags));
router.post('/users/:userId/account-status', manageUsers, asyncHandler(admin.userAccountStatus));
router.post('/users/:userId/force-logout', manageUsers, asyncHandler(admin.userForceLogout));
router.post(
  '/users/:userId/force-password-reset',
  manageUsers,
  asyncHandler(admin.userForcePasswordReset),
);
router.post('/users/:userId/verify-email', manageUsers, asyncHandler(admin.userVerifyEmail));
router.post('/users/:userId/impersonate', impersonate, asyncHandler(admin.userImpersonate));

router.get('/kyc/analytics', viewCompliance, asyncHandler(admin.kycAnalytics));
router.get('/kyc/pending', viewCompliance, asyncHandler(admin.kycPending));
router.get('/kyc/list', viewCompliance, asyncHandler(admin.kycList));
router.get('/kyc/users/:userId', viewCompliance, asyncHandler(admin.kycUser));
router.put('/kyc/users/:userId/status', manageKyc, asyncHandler(admin.kycStatus));

router.get('/kyb/list', viewCompliance, asyncHandler(admin.kybList));
router.get('/kyb/:userId', viewCompliance, asyncHandler(admin.kybUser));
router.put('/kyb/:userId/status', manageKyc, asyncHandler(admin.kybStatus));

router.get('/subscriptions/analytics', viewFinance, asyncHandler(admin.subscriptionAnalytics));
router.get('/subscriptions/list', viewFinance, asyncHandler(admin.subscriptionList));
router.get(
  '/subscriptions/:subscriptionId/details',
  viewFinance,
  asyncHandler(admin.subscriptionDetails),
);
router.post(
  '/subscriptions/:subscriptionId/status',
  manageSubscriptions,
  asyncHandler(admin.subscriptionStatus),
);
router.get('/charges', viewFinance, asyncHandler(admin.chargeList));
router.get('/packages', viewFinance, asyncHandler(admin.packageList));

router.get('/cards', viewTransactions, asyncHandler(admin.cardList));
router.get('/cards/:cardId', viewTransactions, asyncHandler(admin.cardDetails));
router.post('/cards/:cardId/lock', manageCards, asyncHandler(admin.cardLock));
router.post('/cards/:cardId/unlock', manageCards, asyncHandler(admin.cardUnlock));
router.post('/cards/:cardId/status', manageCards, asyncHandler(admin.cardStatus));
router.patch('/cards/:cardId/limit', manageCards, asyncHandler(admin.cardLimit));

router.get('/paypal/orders', viewFinance, asyncHandler(admin.paypalList));
router.get('/sep-purchases/stripe', viewFinance, asyncHandler(admin.stripeList));
router.get('/wert/orders', viewFinance, asyncHandler(admin.wertList));

router.get('/savings-plans', viewFinance, asyncHandler(admin.savingsList));
router.get('/savings-plans/:planId', viewFinance, asyncHandler(admin.savingsDetails));
router.post('/savings-plans/:planId/status', manageSavings, asyncHandler(admin.savingsStatus));
router.post(
  '/savings-plans/:planId/terminate',
  manageSavings,
  asyncHandler(admin.savingsTerminate),
);
router.post('/savings-plans/:planId/notes', manageSavings, asyncHandler(admin.savingsNote));

router.get('/referrals/list', viewMarketing, asyncHandler(admin.referralList));
router.put(
  '/referrals/:referrerId/reward-status',
  manageReferrals,
  asyncHandler(admin.referralStatus),
);

router.get('/notifications', viewDashboard, asyncHandler(admin.notificationList));
router.post('/notifications', manageNotifications, asyncHandler(admin.notificationCreate));

router.get('/audit/unified', viewAudit, asyncHandler(admin.auditList));
router.get('/system/logs', viewSystem, asyncHandler(admin.systemLogs));

router.get('/feature-flags', viewSystem, asyncHandler(admin.flagList));
router.post('/feature-flags', manageFlags, asyncHandler(admin.flagUpsert));
router.delete('/feature-flags/:key', manageFlags, asyncHandler(admin.flagDelete));

router.get('/saved-views', viewDashboard, asyncHandler(admin.savedViewList));
router.post('/saved-views', viewDashboard, asyncHandler(admin.savedViewCreate));
router.delete('/saved-views/:id', viewDashboard, asyncHandler(admin.savedViewDelete));

router.get('/fraud/cases', viewFraud, asyncHandler(admin.fraudList));
router.post('/fraud/cases', manageFraud, asyncHandler(admin.fraudCreate));
router.patch('/fraud/cases/:id/status', manageFraud, asyncHandler(admin.fraudStatus));
router.post('/fraud/cases/:id/notes', manageFraud, asyncHandler(admin.fraudNote));

router.get('/pending-actions', approve, asyncHandler(admin.pendingList));
router.post('/pending-actions', approve, asyncHandler(admin.pendingCreate));
router.post('/pending-actions/:id/approve', approve, asyncHandler(admin.pendingDecide));
router.post('/pending-actions/:id/reject', approve, asyncHandler(admin.pendingDecide));

router.get('/security/settings', requireSuperAdmin, asyncHandler(admin.securityGet));
router.patch('/security/settings', requireSuperAdmin, asyncHandler(admin.securityPatch));
router.get('/security/kill-switch', requireSuperAdmin, asyncHandler(admin.killSwitchGet));
router.post('/security/kill-switch', requireSuperAdmin, asyncHandler(admin.killSwitchSet));
router.post('/security/sessions/revoke', requireSuperAdmin, asyncHandler(admin.revokeSession));

export default router;
