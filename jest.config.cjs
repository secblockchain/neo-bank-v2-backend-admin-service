/**
 * Backend testing — same conventions as the other neo-bank services.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/src/jest-test-cases/jest.setup.ts'],
  clearMocks: true,
  silent: true,
};
