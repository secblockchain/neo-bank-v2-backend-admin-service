import { Request, Response } from 'express';
import {
  sendCreatedResponse,
  sendPaginatedResponse,
  sendSuccessResponse,
} from '../../utils/apiResponseHandler';
import { ApiError } from '../../utils/ApiError';
import { parsePage } from '../../utils/query';
import { actorFromRequest } from '../../services/audit.service';
import { ADMIN_ROLE, permissionsForRole, ROLE_PERMISSIONS } from '../../enums/adminRoles';
import * as auth from '../../services/adminAuth.service';
import * as dashboard from '../../services/dashboard.service';
import * as users from '../../services/users.service';
import * as kyc from '../../services/kyc.service';
import * as subscriptions from '../../services/subscriptions.service';
import * as commerce from '../../services/commerce.service';
import * as platform from '../../services/platform.service';
import * as pilots from '../../services/pilots.service';
import * as money from '../../services/money.service';
import * as ops from '../../services/ops.service';
import { globalSearch } from '../../services/search.service';

function pageOf(req: Request) {
  return parsePage(req.query as Record<string, unknown>);
}

function queryOf(req: Request) {
  return req.query as Record<string, unknown>;
}

function ok(req: Request, res: Response, data: object | object[], message: string) {
  return sendSuccessResponse(res, data, message, undefined, { requestId: req.requestId });
}

async function paged(
  req: Request,
  res: Response,
  loader: (skip: number, limit: number) => Promise<{ items: object[]; total: number }>,
  message: string,
) {
  const { page, limit, skip } = pageOf(req);
  const result = await loader(skip, limit);
  return sendPaginatedResponse(res, result.items, page, limit, result.total, message, {
    requestId: req.requestId,
  });
}

function requireBodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${field} is required.`);
  }
  return value.trim();
}

export async function login(req: Request, res: Response) {
  const email = requireBodyString(req.body ?? {}, 'email');
  const password = requireBodyString(req.body ?? {}, 'password');
  const result = await auth.loginAdmin(email, password);
  return ok(req, res, result, 'Logged in.');
}

export async function logout(req: Request, res: Response) {
  await auth.logoutAdmin(actorFromRequest(req));
  return ok(req, res, { loggedOut: true }, 'Logged out.');
}

export async function me(req: Request, res: Response) {
  const admin = req.admin;
  if (!admin) throw new ApiError(401, 'Admin session required.');
  return ok(
    req,
    res,
    {
      id: String(admin._id),
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      role: admin.role,
      permissions: permissionsForRole(admin.role),
    },
    'Permissions retrieved.',
  );
}

export async function roleCatalog(req: Request, res: Response) {
  const roles = (Object.values(ADMIN_ROLE) as ADMIN_ROLE[]).map((role) => ({
    role,
    permissions: ROLE_PERMISSIONS[role],
  }));
  return ok(req, res, roles, 'Roles retrieved.');
}

export async function getAdmins(req: Request, res: Response) {
  return ok(req, res, await auth.listAdmins(), 'Admins retrieved.');
}

export async function postAdmin(req: Request, res: Response) {
  const body = req.body ?? {};
  const admin = await auth.createAdmin(actorFromRequest(req), {
    email: requireBodyString(body, 'email'),
    password: requireBodyString(body, 'password'),
    firstName: requireBodyString(body, 'firstName'),
    lastName: requireBodyString(body, 'lastName'),
    role: requireBodyString(body, 'role'),
  });
  return sendCreatedResponse(res, admin, 'Admin created.', undefined, { requestId: req.requestId });
}

export async function putAdminRole(req: Request, res: Response) {
  const admin = await auth.updateAdminRole(
    actorFromRequest(req),
    String(req.params.userId),
    requireBodyString(req.body ?? {}, 'role'),
  );
  return ok(req, res, admin, 'Admin role updated.');
}

export async function overview(req: Request, res: Response) {
  return ok(req, res, await dashboard.getDashboardOverview(), 'Dashboard overview retrieved.');
}

export async function search(req: Request, res: Response) {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  return ok(req, res, await globalSearch(q), 'Search results retrieved.');
}

export async function userAnalytics(req: Request, res: Response) {
  return ok(req, res, await users.getUserAnalytics(), 'User analytics retrieved.');
}

export async function userList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => users.listUsers(queryOf(req), skip, limit),
    'Users retrieved.',
  );
}

export async function userProfile(req: Request, res: Response) {
  return ok(
    req,
    res,
    await users.getUserProfile(String(req.params.userId)),
    'User profile retrieved.',
  );
}

export async function userAccountStatus(req: Request, res: Response) {
  const updated = await users.setAccountStatus(
    actorFromRequest(req),
    String(req.params.userId),
    requireBodyString(req.body ?? {}, 'accountStatus'),
  );
  return ok(req, res, updated.toObject(), 'Account status updated.');
}

export async function userForceLogout(req: Request, res: Response) {
  const updated = await users.forceLogout(actorFromRequest(req), String(req.params.userId));
  return ok(req, res, updated.toObject(), 'User sessions ended.');
}

export async function userForcePasswordReset(req: Request, res: Response) {
  const updated = await users.forcePasswordReset(actorFromRequest(req), String(req.params.userId));
  return ok(req, res, updated.toObject(), 'Password reset required.');
}

export async function userVerifyEmail(req: Request, res: Response) {
  const updated = await users.verifyUserEmail(actorFromRequest(req), String(req.params.userId));
  return ok(req, res, updated.toObject(), 'Email marked verified.');
}

export async function userImpersonate(req: Request, res: Response) {
  const token = await users.impersonateUser(actorFromRequest(req), String(req.params.userId));
  return ok(req, res, token, 'Impersonation token issued.');
}

export async function userNotes(req: Request, res: Response) {
  return ok(req, res, await users.listUserNotes(String(req.params.userId)), 'Notes retrieved.');
}

export async function userAddNote(req: Request, res: Response) {
  const note = await users.addUserNote(
    actorFromRequest(req),
    String(req.params.userId),
    requireBodyString(req.body ?? {}, 'body'),
  );
  return sendCreatedResponse(res, note.toObject(), 'Note added.', undefined, {
    requestId: req.requestId,
  });
}

export async function userTags(req: Request, res: Response) {
  const tags = req.body?.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new ApiError(400, 'tags must be an array of strings.');
  }
  const doc = await users.setUserTags(actorFromRequest(req), String(req.params.userId), tags);
  return ok(req, res, doc.toObject(), 'Tags updated.');
}

export async function allTags(req: Request, res: Response) {
  return ok(req, res, await users.listAllUserTags(), 'Tags retrieved.');
}

export async function kycAnalytics(req: Request, res: Response) {
  return ok(req, res, await kyc.getKycAnalytics(), 'KYC analytics retrieved.');
}

export async function kycList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => kyc.listKyc(queryOf(req), skip, limit),
    'KYC records retrieved.',
  );
}

export async function kycPending(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => kyc.listKyc({ ...queryOf(req), pending: 'true' }, skip, limit),
    'Pending KYC retrieved.',
  );
}

export async function kycUser(req: Request, res: Response) {
  return ok(req, res, await kyc.getKycByUser(String(req.params.userId)), 'KYC retrieved.');
}

export async function kycStatus(req: Request, res: Response) {
  const updated = await kyc.updateKycStatus(
    actorFromRequest(req),
    String(req.params.userId),
    requireBodyString(req.body ?? {}, 'kycApprovedStatus'),
    typeof req.body?.rejectionReason === 'string' ? req.body.rejectionReason : undefined,
  );
  return ok(req, res, updated.toObject(), 'KYC status updated.');
}

export async function kybList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => kyc.listKyb(queryOf(req), skip, limit),
    'KYB records retrieved.',
  );
}

export async function kybUser(req: Request, res: Response) {
  return ok(req, res, await kyc.getKybByUser(String(req.params.userId)), 'KYB retrieved.');
}

export async function kybStatus(req: Request, res: Response) {
  const updated = await kyc.updateKybStatus(
    actorFromRequest(req),
    String(req.params.userId),
    requireBodyString(req.body ?? {}, 'kycApprovedStatus'),
  );
  return ok(req, res, updated.toObject(), 'KYB status updated.');
}

export async function subscriptionAnalytics(req: Request, res: Response) {
  return ok(
    req,
    res,
    await subscriptions.getSubscriptionAnalytics(),
    'Subscription analytics retrieved.',
  );
}

export async function subscriptionList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => subscriptions.listSubscriptions(queryOf(req), skip, limit),
    'Subscriptions retrieved.',
  );
}

export async function subscriptionDetails(req: Request, res: Response) {
  return ok(
    req,
    res,
    await subscriptions.getSubscription(String(req.params.subscriptionId)),
    'Subscription retrieved.',
  );
}

export async function subscriptionStatus(req: Request, res: Response) {
  const updated = await subscriptions.setSubscriptionStatus(
    actorFromRequest(req),
    String(req.params.subscriptionId),
    requireBodyString(req.body ?? {}, 'status'),
  );
  return ok(req, res, updated.toObject(), 'Subscription status updated.');
}

export async function chargeList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => subscriptions.listCharges(queryOf(req), skip, limit),
    'Charges retrieved.',
  );
}

export async function packageList(req: Request, res: Response) {
  return ok(req, res, await subscriptions.listPackages(), 'Packages retrieved.');
}

export async function cardList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listCards(queryOf(req), skip, limit),
    'Cards retrieved.',
  );
}

export async function cardAnalytics(req: Request, res: Response) {
  return ok(req, res, await commerce.getCardAnalytics(), 'Card analytics retrieved.');
}

export async function savingsAnalytics(req: Request, res: Response) {
  return ok(req, res, await commerce.getSavingsAnalytics(), 'Savings analytics retrieved.');
}

export async function cardDetails(req: Request, res: Response) {
  return ok(req, res, await commerce.getCard(String(req.params.cardId)), 'Card retrieved.');
}

export async function cardLock(req: Request, res: Response) {
  const updated = await commerce.lockCard(actorFromRequest(req), String(req.params.cardId));
  return ok(req, res, updated.toObject(), 'Card locked.');
}

export async function cardUnlock(req: Request, res: Response) {
  const updated = await commerce.unlockCard(actorFromRequest(req), String(req.params.cardId));
  return ok(req, res, updated.toObject(), 'Card unlocked.');
}

export async function cardStatus(req: Request, res: Response) {
  const updated = await commerce.setCardStatus(
    actorFromRequest(req),
    String(req.params.cardId),
    requireBodyString(req.body ?? {}, 'status'),
  );
  return ok(req, res, updated.toObject(), 'Card status updated.');
}

export async function cardLimit(req: Request, res: Response) {
  const rawAmount = req.body?.amount;
  const amount = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
    throw new ApiError(400, 'amount is required.');
  }
  const frequency = req.body?.frequency;
  if (frequency !== undefined && typeof frequency !== 'string') {
    throw new ApiError(400, 'frequency must be a string.');
  }
  const updated = await commerce.setCardLimit(actorFromRequest(req), String(req.params.cardId), {
    amount,
    frequency: typeof frequency === 'string' ? frequency : undefined,
  });
  return ok(req, res, updated.toObject(), 'Card limit updated.');
}

export async function paypalList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listPayPal(queryOf(req), skip, limit),
    'PayPal orders retrieved.',
  );
}

export async function stripeList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listStripe(queryOf(req), skip, limit),
    'Stripe payments retrieved.',
  );
}

export async function wertList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listWert(queryOf(req), skip, limit),
    'Wert orders retrieved.',
  );
}

export async function savingsList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listSavings(queryOf(req), skip, limit),
    'Savings plans retrieved.',
  );
}

export async function savingsDetails(req: Request, res: Response) {
  return ok(
    req,
    res,
    await commerce.getSavingsPlan(String(req.params.planId)),
    'Savings plan retrieved.',
  );
}

export async function savingsStatus(req: Request, res: Response) {
  const updated = await commerce.setSavingsStatus(
    actorFromRequest(req),
    String(req.params.planId),
    requireBodyString(req.body ?? {}, 'status'),
  );
  return ok(req, res, updated.toObject(), 'Savings plan status updated.');
}

export async function savingsTerminate(req: Request, res: Response) {
  const path = req.body?.path;
  if (path !== undefined && typeof path !== 'string') {
    throw new ApiError(400, 'path must be a string.');
  }
  const updated = await commerce.terminateSavingsPlan(
    actorFromRequest(req),
    String(req.params.planId),
    typeof path === 'string' ? path : undefined,
  );
  return ok(req, res, updated.toObject(), 'Savings plan terminated.');
}

export async function savingsNote(req: Request, res: Response) {
  const updated = await commerce.addSavingsAdminNote(
    actorFromRequest(req),
    String(req.params.planId),
    requireBodyString(req.body ?? {}, 'body'),
  );
  return ok(req, res, updated.toObject(), 'Savings plan note added.');
}

export async function referralList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listReferrals(skip, limit),
    'Referrals retrieved.',
  );
}

export async function referralStatus(req: Request, res: Response) {
  const updated = await commerce.updateReferralStatus(
    actorFromRequest(req),
    String(req.params.referrerId),
    requireBodyString(req.body ?? {}, 'referredUserId'),
    requireBodyString(req.body ?? {}, 'rewardStatus'),
  );
  return ok(req, res, updated.toObject(), 'Referral status updated.');
}

export async function notificationList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => commerce.listNotifications(skip, limit),
    'Notifications retrieved.',
  );
}

export async function notificationCreate(req: Request, res: Response) {
  const body = req.body ?? {};
  const result = await commerce.createAnnouncement(actorFromRequest(req), {
    title: requireBodyString(body, 'title'),
    message: requireBodyString(body, 'message'),
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    broadcast: body.broadcast === true,
  });
  return sendCreatedResponse(res, result, 'Announcement created.', undefined, {
    requestId: req.requestId,
  });
}

export async function auditList(req: Request, res: Response) {
  return paged(req, res, (skip, limit) => platform.listAudit(skip, limit), 'Audit log retrieved.');
}

export async function systemLogs(req: Request, res: Response) {
  const { page, limit, skip } = pageOf(req);
  const result = await dashboard.listSystemLogs(page, limit, skip);
  return sendPaginatedResponse(
    res,
    result.items,
    page,
    limit,
    result.total,
    'System logs retrieved.',
    {
      requestId: req.requestId,
    },
  );
}

export async function flagList(req: Request, res: Response) {
  return ok(req, res, await platform.listFeatureFlags(), 'Feature flags retrieved.');
}

export async function flagUpsert(req: Request, res: Response) {
  const body = req.body ?? {};
  const flag = await platform.upsertFeatureFlag(actorFromRequest(req), {
    key: requireBodyString(body, 'key'),
    description: typeof body.description === 'string' ? body.description : '',
    enabled: body.enabled === true,
  });
  return ok(req, res, flag.toObject(), 'Feature flag saved.');
}

export async function flagDelete(req: Request, res: Response) {
  return ok(
    req,
    res,
    await platform.deleteFeatureFlag(actorFromRequest(req), String(req.params.key)),
    'Feature flag deleted.',
  );
}

export async function pilotList(req: Request, res: Response) {
  const q = queryOf(req);
  const activeRaw = q.active;
  let active: boolean | undefined;
  if (activeRaw === undefined || activeRaw === null || activeRaw === '') {
    active = undefined;
  } else if (activeRaw === 'true' || activeRaw === true) {
    active = true;
  } else if (activeRaw === 'false' || activeRaw === false) {
    active = false;
  } else {
    throw new ApiError(400, 'active must be true or false.');
  }

  return paged(
    req,
    res,
    (skip, limit) =>
      pilots.listPilots(
        {
          search: typeof q.search === 'string' ? q.search : undefined,
          active,
        },
        skip,
        limit,
      ),
    'Pilots retrieved.',
  );
}

export async function pilotAdd(req: Request, res: Response) {
  const body = req.body ?? {};
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    throw new ApiError(400, 'note must be a string.');
  }
  const pilot = await pilots.addPilot(
    actorFromRequest(req),
    requireBodyString(body, 'email'),
    typeof body.note === 'string' ? body.note : undefined,
  );
  return ok(
    req,
    res,
    typeof pilot.toObject === 'function' ? pilot.toObject() : pilot,
    'Pilot added.',
  );
}

export async function pilotDeactivate(req: Request, res: Response) {
  // Express already decodes path params; do not decodeURIComponent again.
  const email = String(req.params.email ?? '');
  if (!email.trim()) throw new ApiError(400, 'email is required.');
  const pilot = await pilots.deactivatePilot(actorFromRequest(req), email);
  return ok(
    req,
    res,
    typeof pilot.toObject === 'function' ? pilot.toObject() : pilot,
    'Pilot deactivated.',
  );
}

export async function savedViewList(req: Request, res: Response) {
  return ok(
    req,
    res,
    await platform.listSavedViews(String(req.admin?._id)),
    'Saved views retrieved.',
  );
}

export async function savedViewCreate(req: Request, res: Response) {
  const body = req.body ?? {};
  const view = await platform.saveSavedView(actorFromRequest(req), {
    name: requireBodyString(body, 'name'),
    resource: requireBodyString(body, 'resource'),
    query:
      body.query && typeof body.query === 'object' ? (body.query as Record<string, unknown>) : {},
  });
  return sendCreatedResponse(res, view.toObject(), 'Saved view created.', undefined, {
    requestId: req.requestId,
  });
}

export async function savedViewDelete(req: Request, res: Response) {
  return ok(
    req,
    res,
    await platform.deleteSavedView(actorFromRequest(req), String(req.params.id)),
    'Saved view deleted.',
  );
}

export async function fraudList(req: Request, res: Response) {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  return paged(
    req,
    res,
    (skip, limit) => platform.listFraudCases(skip, limit, status),
    'Fraud cases retrieved.',
  );
}

export async function fraudCreate(req: Request, res: Response) {
  const body = req.body ?? {};
  const fraudCase = await platform.createFraudCase(actorFromRequest(req), {
    title: requireBodyString(body, 'title'),
    summary: typeof body.summary === 'string' ? body.summary : '',
    userId: typeof body.userId === 'string' ? body.userId : undefined,
  });
  return sendCreatedResponse(res, fraudCase.toObject(), 'Fraud case created.', undefined, {
    requestId: req.requestId,
  });
}

export async function fraudStatus(req: Request, res: Response) {
  const fraudCase = await platform.updateFraudCaseStatus(
    actorFromRequest(req),
    String(req.params.id),
    requireBodyString(req.body ?? {}, 'status'),
  );
  return ok(req, res, fraudCase.toObject(), 'Fraud case updated.');
}

export async function fraudNote(req: Request, res: Response) {
  const fraudCase = await platform.addFraudNote(
    actorFromRequest(req),
    String(req.params.id),
    requireBodyString(req.body ?? {}, 'body'),
  );
  return ok(req, res, fraudCase.toObject(), 'Note added.');
}

export async function pendingList(req: Request, res: Response) {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  return paged(
    req,
    res,
    (skip, limit) => platform.listPendingActions(skip, limit, status),
    'Pending actions retrieved.',
  );
}

export async function pendingCreate(req: Request, res: Response) {
  const body = req.body ?? {};
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError(400, 'payload object is required.');
  }
  const action = await platform.proposeAction(actorFromRequest(req), {
    type: requireBodyString(body, 'type'),
    payload: payload as Record<string, unknown>,
  });
  return sendCreatedResponse(res, action.toObject(), 'Action proposed.', undefined, {
    requestId: req.requestId,
  });
}

export async function pendingDecide(req: Request, res: Response) {
  const decision = req.path.endsWith('/approve') ? 'approved' : 'rejected';
  const result = await platform.decidePendingAction(
    actorFromRequest(req),
    String(req.params.id),
    decision,
    typeof req.body?.note === 'string' ? req.body.note : undefined,
  );
  return ok(
    req,
    res,
    { action: result.action.toObject(), result: result.result },
    `Action ${decision}.`,
  );
}

export async function securityGet(req: Request, res: Response) {
  return ok(req, res, await platform.getSecuritySettings(), 'Security settings retrieved.');
}

export async function killSwitchGet(req: Request, res: Response) {
  const settings = await platform.getSecuritySettings();
  return ok(req, res, { killSwitch: Boolean(settings.killSwitch) }, 'Kill switch retrieved.');
}

export async function killSwitchSet(req: Request, res: Response) {
  if (typeof req.body?.enabled !== 'boolean')
    throw new ApiError(400, 'enabled boolean is required.');
  const settings = await platform.setKillSwitch(actorFromRequest(req), req.body.enabled);
  return ok(req, res, settings.toObject(), 'Kill switch updated.');
}

export async function securityPatch(req: Request, res: Response) {
  const list = req.body?.ipAllowlist;
  if (!Array.isArray(list) || list.some((ip) => typeof ip !== 'string')) {
    throw new ApiError(400, 'ipAllowlist must be an array of strings.');
  }
  const settings = await platform.updateIpAllowlist(actorFromRequest(req), list);
  return ok(req, res, settings.toObject(), 'Security settings updated.');
}

export async function revokeSession(req: Request, res: Response) {
  const result = await platform.revokeAdminSession(
    actorFromRequest(req),
    requireBodyString(req.body ?? {}, 'adminId'),
  );
  return ok(req, res, result, 'Admin session revoked.');
}

// --- Money / banking ---

export async function transactionAnalytics(req: Request, res: Response) {
  return ok(
    req,
    res,
    await money.getTransactionAnalytics(queryOf(req)),
    'Transaction analytics retrieved.',
  );
}

export async function transactionList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => money.listTransactions(queryOf(req), skip, limit),
    'Transactions retrieved.',
  );
}

export async function transactionDetails(req: Request, res: Response) {
  return ok(
    req,
    res,
    await money.getTransaction(String(req.params.transactionId)),
    'Transaction retrieved.',
  );
}

export async function transactionExport(req: Request, res: Response) {
  const result = await money.exportTransactionsCsv(queryOf(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.setHeader('X-Export-Limit', String(result.limit));
  res.setHeader('X-Export-Count', String(result.exported));
  res.setHeader('X-Total-Count', String(result.total));
  res.setHeader('X-Export-Truncated', result.truncated ? 'true' : 'false');
  return res.status(200).send(result.csv);
}

export async function accountList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => money.listAccounts(queryOf(req), skip, limit),
    'Accounts retrieved.',
  );
}

export async function accountDetails(req: Request, res: Response) {
  return ok(req, res, await money.getAccount(String(req.params.userId)), 'Account retrieved.');
}

export async function transferList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => money.listTransfers(queryOf(req), skip, limit),
    'Transfers retrieved.',
  );
}

export async function transferDetails(req: Request, res: Response) {
  return ok(req, res, await money.getTransfer(String(req.params.transferId)), 'Transfer retrieved.');
}

export async function statementList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => money.listStatements(queryOf(req), skip, limit),
    'Statements retrieved.',
  );
}

export async function statementDetails(req: Request, res: Response) {
  const year = Number(req.params.year);
  const month = Number(req.params.month);
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  return ok(
    req,
    res,
    await money.getStatementMeta(year, month, userId),
    'Statement metadata retrieved.',
  );
}

// --- Ops ---

export async function walletList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listWallets(queryOf(req), skip, limit),
    'Wallets retrieved.',
  );
}

export async function walletChainAnalytics(req: Request, res: Response) {
  const chainId = String(queryOf(req).chainId || '19518');
  return ok(req, res, await ops.getWalletChainAnalytics(chainId), 'Wallet chain analytics.');
}

export async function walletChainBalances(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listWalletChainBalances(queryOf(req), skip, limit),
    'Wallet chain balances retrieved.',
  );
}

export async function walletDetails(req: Request, res: Response) {
  return ok(req, res, await ops.getWallet(String(req.params.walletId)), 'Wallet retrieved.');
}

export async function cryptoTransactionAnalytics(req: Request, res: Response) {
  return ok(
    req,
    res,
    await ops.getCryptoTransactionAnalytics(queryOf(req)),
    'Crypto transaction analytics.',
  );
}

export async function cryptoTransactionList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listCryptoTransactions(queryOf(req), skip, limit),
    'Crypto transactions retrieved.',
  );
}

export async function stakingList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listStaking(queryOf(req), skip, limit),
    'Staking positions retrieved.',
  );
}

export async function stakingDetails(req: Request, res: Response) {
  return ok(req, res, await ops.getStaking(String(req.params.stakeId)), 'Staking position retrieved.');
}

export async function businessList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listBusiness(queryOf(req), skip, limit),
    'Business accounts retrieved.',
  );
}

export async function businessDetails(req: Request, res: Response) {
  return ok(
    req,
    res,
    await ops.getBusiness(String(req.params.userId)),
    'Business account retrieved.',
  );
}

export async function disputeList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listDisputes(queryOf(req), skip, limit),
    'Disputes retrieved.',
  );
}

export async function disputeDetails(req: Request, res: Response) {
  return ok(req, res, await ops.getDispute(String(req.params.disputeId)), 'Dispute retrieved.');
}

export async function supportList(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listSupportTickets(queryOf(req), skip, limit),
    'Support tickets retrieved.',
  );
}

export async function supportDetails(req: Request, res: Response) {
  return ok(
    req,
    res,
    await ops.getSupportTicket(String(req.params.ticketId)),
    'Support ticket retrieved.',
  );
}

export async function supportReply(req: Request, res: Response) {
  const updated = await ops.replySupportTicket(
    actorFromRequest(req),
    String(req.params.ticketId),
    requireBodyString(req.body ?? {}, 'body'),
  );
  return ok(req, res, updated.toObject(), 'Reply added.');
}

export async function supportStatus(req: Request, res: Response) {
  const updated = await ops.updateSupportTicketStatus(
    actorFromRequest(req),
    String(req.params.ticketId),
    requireBodyString(req.body ?? {}, 'status'),
  );
  return ok(req, res, updated.toObject(), 'Ticket status updated.');
}

export async function customer360(req: Request, res: Response) {
  return ok(
    req,
    res,
    await ops.getCustomer360(String(req.params.userId)),
    'Customer 360 retrieved.',
  );
}

export async function reportsSummary(req: Request, res: Response) {
  return ok(req, res, await ops.getReportsSummary(), 'Reports summary retrieved.');
}

export async function growthInsights(req: Request, res: Response) {
  return ok(req, res, await ops.getGrowthInsights(), 'Growth insights retrieved.');
}

export async function fraudSignals(req: Request, res: Response) {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  return ok(req, res, await ops.getFraudSignals(userId), 'Fraud signals retrieved.');
}

export async function physicalCardOrders(req: Request, res: Response) {
  return paged(
    req,
    res,
    (skip, limit) => ops.listPhysicalCardOrders(queryOf(req), skip, limit),
    'Physical card orders retrieved.',
  );
}

export async function maintenanceGet(req: Request, res: Response) {
  return ok(req, res, await ops.getMaintenanceState(), 'Maintenance state retrieved.');
}

export async function maintenanceSet(req: Request, res: Response) {
  if (typeof req.body?.enabled !== 'boolean') {
    throw new ApiError(400, 'enabled boolean is required.');
  }
  return ok(
    req,
    res,
    await ops.setMaintenanceState(actorFromRequest(req), req.body.enabled),
    'Maintenance state updated.',
  );
}
