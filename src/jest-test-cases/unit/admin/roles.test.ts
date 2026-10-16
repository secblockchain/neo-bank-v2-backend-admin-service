import { ADMIN_PERMISSION, ADMIN_ROLE, roleHasPermission } from '../../../enums/adminRoles';

describe('admin roles', () => {
  it('gives super admin every permission', () => {
    expect(roleHasPermission(ADMIN_ROLE.SUPER_ADMIN, ADMIN_PERMISSION.IMPERSONATE_USERS)).toBe(
      true,
    );
    expect(roleHasPermission(ADMIN_ROLE.SUPER_ADMIN, ADMIN_PERMISSION.MANAGE_ADMINS)).toBe(true);
  });

  it('keeps support off finance writes', () => {
    expect(roleHasPermission(ADMIN_ROLE.SUPPORT, ADMIN_PERMISSION.MANAGE_USERS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.SUPPORT, ADMIN_PERMISSION.MANAGE_CARDS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.SUPPORT, ADMIN_PERMISSION.MANAGE_SUBSCRIPTIONS)).toBe(
      false,
    );
    expect(roleHasPermission(ADMIN_ROLE.SUPPORT, ADMIN_PERMISSION.MANAGE_SAVINGS)).toBe(false);
  });

  it('gives super admin savings management', () => {
    expect(roleHasPermission(ADMIN_ROLE.SUPER_ADMIN, ADMIN_PERMISSION.MANAGE_SAVINGS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.FINANCE, ADMIN_PERMISSION.MANAGE_SAVINGS)).toBe(false);
  });

  it('keeps read only off every write permission', () => {
    expect(roleHasPermission(ADMIN_ROLE.READ_ONLY, ADMIN_PERMISSION.VIEW_USERS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.READ_ONLY, ADMIN_PERMISSION.MANAGE_KYC)).toBe(false);
  });

  it('gives support view and manage pilots; read_only view only', () => {
    expect(roleHasPermission(ADMIN_ROLE.SUPPORT, ADMIN_PERMISSION.VIEW_PILOTS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.SUPPORT, ADMIN_PERMISSION.MANAGE_PILOTS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.READ_ONLY, ADMIN_PERMISSION.VIEW_PILOTS)).toBe(true);
    expect(roleHasPermission(ADMIN_ROLE.READ_ONLY, ADMIN_PERMISSION.MANAGE_PILOTS)).toBe(false);
  });
});
