import { defineConfig } from 'oxfmt';

export default defineConfig({
  singleQuote: true,
  jsdoc: {
    addDefaultToDescription: false,
    keepUnparsableExampleIndent: true,
    lineWrappingStyle: 'balance',
    preferCodeFences: true,
    separateReturnsFromParam: true,
    separateTagGroups: true,
  },
  sortImports: {
    groups: [
      'side_effect',
      'side_effect_style',
      'type',
      ['builtin', 'external'],
      ['internal', 'subpath'],
      ['parent', 'sibling', 'index'],
      'unknown',
      'style',
    ],
  },
});
