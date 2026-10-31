// @ts-check

// Stryker's vitest runner hard-codes `pool: 'threads'`
// (@stryker-mutator/vitest-runner, #getVitestPoolConfig), overriding the
// `pool: "forks"` that vitest.config.ts pins. A worker thread cannot honor a
// `process.env.TZ` pin, so the TZ-pinned regression blocks would abort the
// run — tests/helpers/tz-pin.ts throws by design rather than skipping in
// silence. This is the single sanctioned opt-out: those blocks are skipped
// here, and nowhere else. Set in the config module so Stryker's child
// processes inherit it.
process.env.OC_ALLOW_UNPINNED_TZ = "1";
// Lets wall-clock timing tests loosen their budget: instrumentation makes it meaningless.
process.env.OC_MUTATION_RUN = "1";

// Code that moved into features/ from components/ without a change. It stays
// out of the mutation surface it was never in; adding it is a separate decision.
const MOVED_NOT_MUTATED = [
  "src/features/channels/muteMenu.ts",
  "src/features/messaging/content/attachmentCache.ts",
  "src/features/messaging/content/attachmentUrls.ts",
  "src/features/messaging/content/attachments.ts",
  "src/features/messaging/content/contentParser.ts",
  "src/features/messaging/content/customEmoji.ts",
  "src/features/messaging/content/embeds.ts",
  "src/features/messaging/content/imageSizes.ts",
  "src/features/messaging/content/imageViewer.ts",
  "src/features/messaging/content/media.ts",
  "src/features/messaging/content/syntaxHighlight.ts",
  "src/features/profiles/bannerImages.ts",
  "src/features/voice/voiceStatusText.ts",
];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  vitest: {
    configFile: "vitest.config.ts",
  },
  mutate: [
    "src/lib/**/*.ts",
    "src/stores/**/*.ts",
    "src/features/**/*.ts",
    "src/features/members/memberRow.view.ts",
    "!src/lib/types.ts",
    "!src/lib/wire*.ts", // split out of types.ts, excluded with it
    "!src/features/messaging/emojiData.ts", // generated data, no logic to mutate
    ...MOVED_NOT_MUTATED.map((file) => `!${file}`),
    "!src/**/*.d.ts",
    "!src/**/*.test.ts",
  ],
  reporters: ["html", "clear-text", "progress"],
  // The per-test list marks every passing test that killed no mutant with
  // ✘ or ~, which reads as hundreds of failures in the CI log. Survivors and
  // the score table still print.
  clearTextReporter: {
    reportTests: false,
  },
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  concurrency: 4,
  timeoutMS: 30000,
  // A big shard's perTest-coverage first pass takes longer than Stryker's 5-minute default.
  dryRunTimeoutMinutes: 20,
  tempDirName: ".stryker-tmp",
};

export default config;
