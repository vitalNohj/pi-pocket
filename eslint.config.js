import stylistic from "@stylistic/eslint-plugin";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

// Layout: Prettier formats, and these rules give the code room to breathe. The web app's JavaScript also gets the
// check TypeScript gives the rest (`tsconfig.json` `noUnusedLocals`): no import, variable, or parameter left unused.
export default [
    {
        ignores: ["node_modules/**", "data/**", "docs-site/dist/**", "docs-site/.astro/**"],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
        },
    },
    prettier,
    {
        files: ["**/*.{js,mjs,cjs,ts}"],
        plugins: {
            "@stylistic": stylistic,
        },
        rules: {
            curly: ["error", "all"],
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "directive", next: "*" },
                { blankLine: "any", prev: "directive", next: "directive" },
                { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
                {
                    blankLine: "any",
                    prev: ["const", "let", "var"],
                    next: ["const", "let", "var"],
                },
                {
                    blankLine: "always",
                    prev: "*",
                    next: ["block-like", "return", "throw"],
                },
                { blankLine: "always", prev: "block-like", next: "*" },
            ],
        },
    },
    {
        files: ["web/**/*.js"],
        rules: {
            // `_name` is one that must be there and is not read (a loop that only counts); a key left out of a rest
            // (`const { gone, ...kept }`) is there to be left out.
            "no-unused-vars": [
                "error",
                {
                    args: "after-used",
                    caughtErrors: "all",
                    ignoreRestSiblings: true,
                    varsIgnorePattern: "^_",
                    argsIgnorePattern: "^_",
                },
            ],
        },
    },
];
