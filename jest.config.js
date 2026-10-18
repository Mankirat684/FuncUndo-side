// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/out/', '/src/test/'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
};