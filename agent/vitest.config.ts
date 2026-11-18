import { defineConfig } from 'vitest/config';

// One tsconfig for every file, including the plugin models the panels import.
// The plugins' own tsconfig files extend a file from their node_modules, which the agent build does not install.
export default defineConfig({ tsconfig: './tsconfig.json', test: {} });
